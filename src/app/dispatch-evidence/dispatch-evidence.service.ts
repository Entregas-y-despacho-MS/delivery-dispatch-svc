/// <reference types="multer" />
import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { DeliveryEvidence } from '../../modules/dispatch/delivery-evidences/entities/delivery-evidence.entity.js';
import { DeliveryEvidencesService } from '../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchNotFoundException } from '../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { DispatchesService } from '../../modules/dispatch/dispatches/services/dispatches.service.js';
import { StoragePort } from '../../plugins/storage/storage.port.js';
import { isUniqueViolation } from '../../shared/orm/unique-violation.js';
import { DispatchOtpService } from '../dispatch-otp/dispatch-otp.service.js';
import { assertEvidenceFile } from './domain/evidence-file.js';
import { DeliveryEvidenceDto } from './dto/delivery-evidence.dto.js';
import { RegisterEvidenceDto } from './dto/register-evidence.dto.js';
import { DispatchNotAssignedException, EvidenceIdConflictException, InvalidCaptureTimeException } from './exceptions/index.js';

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
    ) {}

    /**
     * Checks the delivery OTP and, only when it is correct, registers an `otp` evidence. The code is consumed by the
     * check (one use) and is never stored: the evidence is a row without file, coordinates or code.
     */
    async validateOtp(dispatchId: number, driverId: number, code: string): Promise<DeliveryEvidenceDto> {
        await this.otp.validate(dispatchId, driverId, code);
        try {
            const saved = await this.evidences.create({ id: uuidv7(), dispatchId, type: 'otp', capturedAt: new Date() });
            return this.toDto(saved);
        } catch (err) {
            // The code is already spent: leave a trace, since Dispatch must authorize this delivery by hand.
            this.logger.error({ event: 'otp_verified_evidence_not_saved', dispatchId });
            throw err;
        }
    }

    async register(dispatchId: number, driverId: number, dto: RegisterEvidenceDto, file: Express.Multer.File | undefined): Promise<RegisteredEvidence> {
        if (!(await this.dispatches.existsById(dispatchId))) throw new DispatchNotFoundException();
        if (!(await this.dispatches.isAssignedToDriver(dispatchId, driverId))) throw new DispatchNotAssignedException();

        // A retry of a request that already succeeded answers with the original record, before anything is validated again.
        const existing = await this.evidences.findById(dto.evidenceId);
        if (existing) return this.replay(existing, dispatchId);

        const capturedAt = new Date(dto.capturedAt);
        if (capturedAt.getTime() > Date.now() + MAX_FUTURE_MS) throw new InvalidCaptureTimeException();
        const validFile = assertEvidenceFile(dto.type, file);

        const { url } = await this.storage.upload({ buffer: validFile.buffer, filename: `${dto.evidenceId}`, mimeType: validFile.mimetype });
        const isSignature = dto.type === 'signature';
        try {
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
            });
            return { evidence: this.toDto(saved), created: true };
        } catch (err) {
            // Two requests with the same evidenceId at once: the primary key lets one in, the other gets the original.
            if (!isUniqueViolation(err)) throw err;
            const original = await this.evidences.findById(dto.evidenceId);
            if (!original) throw err;
            return this.replay(original, dispatchId);
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
