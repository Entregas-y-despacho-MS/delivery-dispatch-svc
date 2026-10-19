import { ApiProperty } from '@nestjs/swagger';

export class CotejoPhotoDto {
  @ApiProperty({
    format: 'uuid',
    example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10',
    description:
      'The photo ID to send in `failures[].photoId` of the accept call. The stored file URL is never returned.',
  })
  photoId!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-20T07:42:00.000Z',
    description: 'UTC instant when the server stored the photo.',
  })
  uploadedAt!: string;
}
