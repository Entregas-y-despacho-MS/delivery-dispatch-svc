import { ConflictException } from '@nestjs/common';

export class CotejoPhotoIdConflictException extends ConflictException {
  constructor() {
    super({
      message: 'This photoId already belongs to another route batch.',
      error: 'COTEJO_PHOTO_ID_CONFLICT',
    });
  }
}
