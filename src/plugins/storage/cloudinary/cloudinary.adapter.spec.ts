import { describe, expect, it, vi } from 'vitest';

const privateDownloadUrl = vi.hoisted(() => vi.fn(() => 'https://api.cloudinary.com/signed'));
vi.mock('cloudinary', () => ({
    v2: { config: vi.fn(), uploader: {}, utils: { private_download_url: privateDownloadUrl } },
}));

import { CloudinaryAdapter } from './cloudinary.adapter.js';
import type { CloudinaryConfig } from './cloudinary.config.js';
import { StorageUploadException } from '../exceptions/index.js';

const adapter = new CloudinaryAdapter({ cloudName: 'c', apiKey: 'k', apiSecret: 's', folder: 'f' } as CloudinaryConfig);

describe('CloudinaryAdapter.getAccessUrl', () => {
    it('signs a download for the public id and format with the requested expiry', async () => {
        const before = Math.floor(Date.now() / 1000);
        const { url, expiresAt } = await adapter.getAccessUrl('https://res.cloudinary.com/c/image/upload/v17/delivery-dispatch/abc.jpg', 120);
        expect(url).toBe('https://api.cloudinary.com/signed');
        expect(privateDownloadUrl).toHaveBeenCalledWith('delivery-dispatch/abc', 'jpg', expect.objectContaining({
            resource_type: 'image', type: 'upload', expires_at: expect.any(Number),
        }));
        expect(Math.floor(expiresAt.getTime() / 1000)).toBeGreaterThanOrEqual(before + 120);
    });

    it('rejects a URL that is not a Cloudinary upload URL', async () => {
        await expect(adapter.getAccessUrl('http://x/uploads/a.png', 60)).rejects.toBeInstanceOf(StorageUploadException);
    });
});
