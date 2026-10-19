/// <reference types="multer" />
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { assertEvidenceFile } from '../../../../app/dispatch-evidence/domain/evidence-file.js';
import { InsufficientPermissionsException } from '../../../../app/auth/exceptions/index.js';
import { StoragePort } from '../../../../plugins/storage/storage.port.js';
import { assertDriverCanAcceptBatch } from '../domain/batch-acceptance.js';
import { CotejoPhotoDto } from '../dto/cotejo-photo.dto.js';
import { UploadCotejoPhotoDto } from '../dto/upload-cotejo-photo.dto.js';
import { CotejoPhotoIdConflictException } from '../exceptions/cotejo-photo-id-conflict.exception.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';

/** Event that records a cotejo photo; the accept call (ST-210.1) accepts only photos found here for its own batch. */
export const COTEJO_PHOTO_EVENT_TYPE = 'cotejo_photo_uploaded';

export interface UploadedCotejoPhoto {
  photo: CotejoPhotoDto;
  /** False when the photoId was already uploaded and the original record is returned. */
  created: boolean;
}

interface PhotoEventRow {
  route_batch_id: number;
  created_at: Date;
}

// Step 1 of the cotejo failure flow: the photo travels alone (multipart) so that the accept call stays a
// plain JSON body the offline queue can retry. Only the stored URL is kept, in the batch event log.
@Injectable()
export class RouteBatchCotejoPhotoService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StoragePort,
  ) {}

  async upload(
    routeBatchId: number,
    driverId: number,
    dto: UploadCotejoPhotoDto,
    file: Express.Multer.File | undefined,
  ): Promise<UploadedCotejoPhoto> {
    return await this.dataSource.transaction(async (manager) => {
      const [batch]: { status: string; driver_id: number | null }[] =
        await manager.query(
          `SELECT status, driver_id FROM route_batches WHERE route_batch_id = $1`,
          [routeBatchId],
        );
      if (!batch) throw new RouteBatchNotFoundException();
      if (batch.driver_id !== driverId)
        throw new InsufficientPermissionsException();

      // Requests with the same photoId go through here one at a time: the second finds the first one's row.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `cotejo-photo:${dto.photoId}`,
      ]);
      const [prior]: PhotoEventRow[] = await manager.query(
        `SELECT route_batch_id, created_at FROM route_batch_events
          WHERE event_type = $1 AND metadata->>'photoId' = $2 LIMIT 1`,
        [COTEJO_PHOTO_EVENT_TYPE, dto.photoId],
      );
      if (prior) {
        if (prior.route_batch_id !== routeBatchId)
          throw new CotejoPhotoIdConflictException();
        return {
          photo: {
            photoId: dto.photoId,
            uploadedAt: prior.created_at.toISOString(),
          },
          created: false,
        };
      }

      assertDriverCanAcceptBatch(batch.status);
      const validFile = assertEvidenceFile('photo', file);
      const { url } = await this.storage.upload({
        buffer: validFile.buffer,
        filename: dto.photoId,
        mimeType: validFile.mimetype,
      });
      const [saved]: { created_at: Date }[] = await manager.query(
        `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
         VALUES ($1, $2, $3, 'user', 'Cotejo photo uploaded', $4::jsonb) RETURNING created_at`,
        [
          routeBatchId,
          COTEJO_PHOTO_EVENT_TYPE,
          driverId,
          JSON.stringify({ photoId: dto.photoId, photoUrl: url }),
        ],
      );
      return {
        photo: {
          photoId: dto.photoId,
          uploadedAt: saved.created_at.toISOString(),
        },
        created: true,
      };
    });
  }
}
