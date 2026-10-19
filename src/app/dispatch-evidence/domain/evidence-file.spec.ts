/// <reference types="multer" />
import { EvidenceFileRequiredException, UnsupportedEvidenceFileTypeException } from '../exceptions/index.js';
import { assertEvidenceFile } from './evidence-file.js';

const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype }) as Express.Multer.File;

describe('assertEvidenceFile', () => {
    it('accepts a PNG signature and a JPEG photo', () => {
        const signature = file(PNG, 'image/png');
        const photo     = file(JPEG, 'image/jpeg');
        expect(assertEvidenceFile('signature', signature)).toBe(signature);
        expect(assertEvidenceFile('photo', photo)).toBe(photo);
    });

    it('rejects a missing or empty file with 400', () => {
        expect(() => assertEvidenceFile('photo', undefined)).toThrow(EvidenceFileRequiredException);
        expect(() => assertEvidenceFile('photo', file(Buffer.alloc(0), 'image/jpeg'))).toThrow(EvidenceFileRequiredException);
    });

    it('rejects the wrong image type for the evidence type with 415', () => {
        expect(() => assertEvidenceFile('signature', file(JPEG, 'image/jpeg'))).toThrow(UnsupportedEvidenceFileTypeException);
        expect(() => assertEvidenceFile('photo', file(PNG, 'image/png'))).toThrow(UnsupportedEvidenceFileTypeException);
    });

    it('rejects a file whose bytes are not the declared image with 415', () => {
        expect(() => assertEvidenceFile('photo', file(Buffer.from('<html></html>'), 'image/jpeg'))).toThrow(UnsupportedEvidenceFileTypeException);
        expect(() => assertEvidenceFile('signature', file(Buffer.from('<svg/>'), 'image/png'))).toThrow(UnsupportedEvidenceFileTypeException);
    });
});
