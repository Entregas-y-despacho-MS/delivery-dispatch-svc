/// <reference types="multer" />
import { EvidenceFileRequiredException, UnsupportedEvidenceFileTypeException } from '../exceptions/index.js';

/** 500 KB, the ceiling the app compresses to. Multer rejects anything bigger with 413. */
export const MAX_EVIDENCE_FILE_BYTES = 500 * 1024;

export type FileEvidenceType = 'signature' | 'photo';

interface FileRule {
    mimeType:  string;
    label:     string;
    signature: number[];
}

// A signature is a PNG and a photo a JPEG. The declared Content-Type is the client's word, so the
// first bytes of the file are checked too: local storage serves uploads from the API's own origin.
const RULES: Record<FileEvidenceType, FileRule> = {
    signature: { mimeType: 'image/png',  label: 'PNG',  signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    photo:     { mimeType: 'image/jpeg', label: 'JPEG', signature: [0xff, 0xd8, 0xff] },
};

/** Throws 400 when the file is missing and 415 when it is not the image its evidence type needs. */
export function assertEvidenceFile(type: FileEvidenceType, file: Express.Multer.File | undefined): Express.Multer.File {
    if (!file?.buffer?.length) throw new EvidenceFileRequiredException();
    const rule = RULES[type];
    const matchesSignature = rule.signature.every((byte, index) => file.buffer[index] === byte);
    if (file.mimetype !== rule.mimeType || !matchesSignature) throw new UnsupportedEvidenceFileTypeException(rule.label);
    return file;
}
