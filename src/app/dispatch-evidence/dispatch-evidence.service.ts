/// <reference types="multer" />
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { DeliveryEvidence } from '../../modules/dispatch/delivery-evidences/entities/delivery-evidence.entity.js';
import { DeliveryEvidencesService } from '../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchNotFoundException } from '../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { DispatchesService } from '../../modules/dispatch/dispatches/services/dispatches.service.js';
import { StoragePort } from '../../plugins/storage/storage.port.js';
import { DispatchStatusEnum } from '../../shared/enums/dispatch-status.enum.js';
import { isUniqueViolation } from '../../shared/orm/unique-violation.js';
import { DispatchOtpException, OTP_CONSUMED_MESSAGE } from '../dispatch-otp/exceptions/dispatch-otp.exception.js';
import { DispatchOtpService } from '../dispatch-otp/dispatch-otp.service.js';
import { DISPATCH_EVIDENCE_REGISTERED_EVENT, type DispatchEvidenceRegisteredEvent } from './dispatch-evidence-registered.event.js';
import { assertEvidenceFile } from './domain/evidence-file.js';
import { DeliveryEvidenceDto } from './dto/delivery-evidence.dto.js';
import { RegisterEvidenceDto } from './dto/register-evidence.dto.js';
import { DispatchNotAssignedException, DispatchNotInTransitException, EvidenceIdConflictException, InvalidCaptureTimeException } from './exceptions/index.js';

// A device clock is never exact, so a capture time slightly ahead of the server's is tolerated.
const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface RegisteredEvidence {
    evidence: DeliveryEvidenceDto;
    /** False when the evidenceId was already registered and the original record is returned. */
    created: boolean;
}

// Registers the signature/photo evidence of a delivery (ST-31.3). It never moves the dispatch to
// `delivered`: that happens only through the status endpoint (ST-30.3), which checks this evidence.
@Injectable()
export class DispatchEvidenceService {
    private readonly logger = new Logger(DispatchEvidenceService.name);

    constructor(
        private readonly evidences: DeliveryEvidencesService,
        private readonly dispatches: DispatchesService,
        private readonly storage: StoragePort,
        private readonly otp: DispatchOtpService,
        private readonly events: EventEmitter2,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    /**
     * Checks the delivery OTP and, only when it is correct, registers an `otp` evidence. The code is consumed by the
     * check (one use) and is never stored: the evidence is a row without file, coordinates or code.
     *
     * Consuming the code (Redis) and saving the evidence (PostgreSQL) cannot be one transaction, so the id the evidence
     * will have is recorded with the consumption. If the save fails, the code stays spent but the driver sends it again:
     * the check finds the recorded id, sees there is no row yet and finishes the registration (a true second use finds
     * the row and is refused). A dispatch-level lock makes simultaneous requests wait for the one that is saving, so none
     * of them mistakes work in progress for work that failed. If the save keeps failing, Dispatch sees an
     * `otp_resolution_required` marker.
     */
    async validateOtp(dispatchId: number, driverId: number, code: string): Promise<DeliveryEvidenceDto> {
        let owesEvidence = false;
        let saved: DeliveryEvidence;
        try {
            saved = await this.dataSource.transaction(async (manager) => {
                await this.lock(manager, `dispatch-otp-evidence:${dispatchId}`);
                const validation = await this.otp.validate(dispatchId, driverId, code, uuidv7(), manager);
                if (await this.evidences.findById(validation.evidenceId, { manager })) {
                    throw new DispatchOtpException('OTP_CONSUMED', OTP_CONSUMED_MESSAGE, 409);
                }
                owesEvidence = true;
                return await this.evidences.create({ id: validation.evidenceId, dispatchId, type: 'otp', capturedAt: new Date() }, { manager });
            });
        } catch (err) {
            if (owesEvidence) await this.reportUnsavedOtpEvidence(dispatchId);
            throw err;
        }
        this.publish(saved);
        return this.toDto(saved);
    }

    async register(dispatchId: number, driverId: number, dto: RegisterEvidenceDto, file: Express.Multer.File | undefined): Promise<RegisteredEvidence> {
        if (!(await this.dispatches.existsById(dispatchId))) throw new DispatchNotFoundException();
        if (!(await this.dispatches.isAssignedToDriver(dispatchId, driverId))) throw new DispatchNotAssignedException();

        // A retry of a request that already succeeded answers with the original record, before anything is validated again.
        const existing = await this.evidences.findById(dto.evidenceId);
        if (existing) return this.replay(existing, dispatchId);

        // The proof is captured at the door, so it arrives while the dispatch is in transit and before `delivered`
        // (which requires it). Anything else is a late or stray upload that would rewrite what the 360° file shows.
        if ((await this.dispatches.getStatusName(dispatchId)) !== DispatchStatusEnum.IN_TRANSIT) throw new DispatchNotInTransitException();

        const capturedAt = new Date(dto.capturedAt);
        if (capturedAt.getTime() > Date.now() + MAX_FUTURE_MS) throw new InvalidCaptureTimeException();
        const validFile = assertEvidenceFile(dto.type, file);
        const isSignature = dto.type === 'signature';

        let outcome: { original: DeliveryEvidence } | { saved: DeliveryEvidence };
        try {
            outcome = await this.dataSource.transaction(async (manager) => {
                // Requests with the same evidenceId go through here one at a time: the second one finds the first one's row
                // and neither uploads another file nor touches the row. The insert below never updates an existing row either.
                await this.lock(manager, `dispatch-evidence:${dto.evidenceId}`);
                const original = await this.evidences.findById(dto.evidenceId, { manager });
                if (original) return { original };
                const { url } = await this.storage.upload({ buffer: validFile.buffer, filename: dto.evidenceId, mimeType: validFile.mimetype });
                const saved = await this.evidences.create({
                    id:               dto.evidenceId,
                    dispatchId,
                    type:             dto.type,
                    fileUrl:          url,
                    capturedAt,
                    latitude:         dto.lat,
                    longitude:        dto.lng,
                    receiverName:     isSignature ? dto.receiverName : null,
                    receiverDocument: isSignature ? dto.receiverDocument : null,
                }, { manager });
                return { saved };
            });
        } catch (err) {
            // Another writer that does not take the lock (the legacy sync) got the same id in first: answer with its row.
            if (!isUniqueViolation(err)) throw err;
            const original = await this.evidences.findById(dto.evidenceId);
            if (!original) throw err;
            return this.replay(original, dispatchId);
        }
        if ('original' in outcome) return this.replay(outcome.original, dispatchId);
        this.publish(outcome.saved);
        return { evidence: this.toDto(outcome.saved), created: true };
    }

    /** Transaction-scoped advisory lock: waits for whoever holds the same key and is released on commit or rollback. */
    private async lock(manager: EntityManager, key: string): Promise<void> {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }

    private async reportUnsavedOtpEvidence(dispatchId: number): Promise<void> {
        this.logger.error({ event: 'otp_verified_evidence_not_saved', dispatchId });
        try {
            await this.otp.markEvidenceNotSaved(dispatchId);
        } catch (err) {
            this.logger.error({ event: 'otp_resolution_marker_not_saved', dispatchId, message: (err as Error).message });
        }
    }

    /**
     * Tells the control tower after the row is saved. A replay does not publish: the first registration already did.
     * A failure here is logged and never surfaces: the evidence exists, and answering an error would make the app
     * retry (or, for an OTP, find the code already spent).
     */
    private publish(evidence: DeliveryEvidence): void {
        try {
            const event: DispatchEvidenceRegisteredEvent = {
                dispatchId:   evidence.dispatchId,
                evidenceId:   evidence.id,
                type:         evidence.type,
                registeredAt: evidence.createdAt.toISOString(),
            };
            this.events.emit(DISPATCH_EVIDENCE_REGISTERED_EVENT, event);
        } catch (err) {
            this.logger.error({ event: 'evidence_registered_not_announced', dispatchId: evidence.dispatchId, message: (err as Error).message });
        }
    }

    private replay(existing: DeliveryEvidence, dispatchId: number): RegisteredEvidence {
        if (existing.dispatchId !== dispatchId) throw new EvidenceIdConflictException();
        return { evidence: this.toDto(existing), created: false };
    }

    private toDto(evidence: DeliveryEvidence): DeliveryEvidenceDto {
        return {
            id:               evidence.id,
            dispatchId:       evidence.dispatchId,
            type:             evidence.type,
            capturedAt:       evidence.capturedAt,
            latitude:         evidence.latitude,
            longitude:        evidence.longitude,
            receiverName:     evidence.receiverName,
            receiverDocument: evidence.receiverDocument,
            createdAt:        evidence.createdAt,
        };
    }
}
