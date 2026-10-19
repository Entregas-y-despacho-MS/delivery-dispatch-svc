import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    privateDownloadUrl: vi.fn(() => 'https://api.cloudinary.com/signed'),
    uploadStream: vi.fn(),
}));
vi.mock('cloudinary', () => ({
    v2: { config: vi.fn(), uploader: { upload_stream: mocks.uploadStream }, utils: { private_download_url: mocks.privateDownloadUrl } },
}));

import { CloudinaryAdapter } from './cloudinary.adapter.js';
import type { CloudinaryConfig } from './cloudinary.config.js';
import { StorageUploadException } from '../exceptions/index.js';

const adapter = new CloudinaryAdapter({ cloudName: 'c', apiKey: 'k', apiSecret: 's', folder: 'f' } as CloudinaryConfig);

describe('CloudinaryAdapter.upload', () => {
    beforeEach(() => mocks.uploadStream.mockReset());

    it('uploads as `authenticated`, so the stored URL does not open without a signature', async () => {
        mocks.uploadStream.mockImplementation((_options, done) => ({
            end: () => done(undefined, { secure_url: 'https://res.cloudinary.com/c/image/authenticated/v1/f/abc.jpg' }),
        }));
        const result = await adapter.upload({ buffer: Buffer.from('x'), filename: 'a.jpg', mimeType: 'image/jpeg' });
        expect(result.url).toBe('https://res.cloudinary.com/c/image/authenticated/v1/f/abc.jpg');
        expect(mocks.uploadStream).toHaveBeenCalledWith(expect.objectContaining({ type: 'authenticated', folder: 'f' }), expect.any(Function));
        // Never the public default, which would leave every stored URL open forever.
        expect(mocks.uploadStream.mock.calls[0][0].type).not.toBe('upload');
    });
});

describe('CloudinaryAdapter.getAccessUrl', () => {
    beforeEach(() => mocks.privateDownloadUrl.mockClear());

    it('signs a download of an authenticated asset with the requested expiry', async () => {
        const before = Math.floor(Date.now() / 1000);
        const { url, expiresAt } = await adapter.getAccessUrl('https://res.cloudinary.com/c/image/authenticated/v17/f/abc.jpg', 120);
        expect(url).toBe('https://api.cloudinary.com/signed');
        expect(mocks.privateDownloadUrl).toHaveBeenCalledWith('f/abc', 'jpg', expect.objectContaining({
            resource_type: 'image', type: 'authenticated', expires_at: expect.any(Number),
        }));
        expect(Math.floor(expiresAt.getTime() / 1000)).toBeGreaterThanOrEqual(before + 120);
    });

    it('ignores the signature segment Cloudinary may put in an authenticated URL', async () => {
        await adapter.getAccessUrl('https://res.cloudinary.com/c/image/authenticated/s--AbC123xy--/v17/f/abc.jpg', 60);
        expect(mocks.privateDownloadUrl).toHaveBeenCalledWith('f/abc', 'jpg', expect.objectContaining({ type: 'authenticated' }));
    });

    it('still signs files stored before ST-56.2, which are public `upload` assets', async () => {
        await adapter.getAccessUrl('https://res.cloudinary.com/c/image/upload/v17/f/old.jpg', 60);
        expect(mocks.privateDownloadUrl).toHaveBeenCalledWith('f/old', 'jpg', expect.objectContaining({ type: 'upload' }));
    });

    it('rejects a URL that is not a Cloudinary asset URL', async () => {
        await expect(adapter.getAccessUrl('http://x/uploads/a.png', 60)).rejects.toBeInstanceOf(StorageUploadException);
    });
});
