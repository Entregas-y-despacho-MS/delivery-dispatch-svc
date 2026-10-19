import { describe, expect, it } from 'vitest';
import { RoleEnum } from '../../../shared/enums/index.js';
import { canRevealTrackingLink, canViewTrackingLink, trackingLinkBlock } from './tracking-link-access.js';

const WITHOUT_EMAIL = { hasContactEmail: false, hasLiveToken: true };

describe('canViewTrackingLink', () => {
    it('is for the coordinator and root, the roles that can also resolve the request', () => {
        expect(canViewTrackingLink(RoleEnum.COORDINATOR)).toBe(true);
        expect(canViewTrackingLink(RoleEnum.ROOT)).toBe(true);
    });

    it.each([RoleEnum.SUPERVISOR, RoleEnum.ADMIN, RoleEnum.DRIVER, 'anything-else', ''])('is not for %j', (role) => {
        expect(canViewTrackingLink(role)).toBe(false);
    });
});

describe('trackingLinkBlock', () => {
    it('lets the link be shown only for a customer without email and with a working token', () => {
        expect(trackingLinkBlock(WITHOUT_EMAIL)).toBeNull();
    });

    it('never shows it to a customer who has an email: they already got it there', () => {
        expect(trackingLinkBlock({ hasContactEmail: true, hasLiveToken: true })).toBe('has_contact_email');
    });

    it('does not show a token that does not exist or already expired', () => {
        expect(trackingLinkBlock({ hasContactEmail: false, hasLiveToken: false })).toBe('no_live_token');
    });

    it('answers the email first when both apply', () => {
        expect(trackingLinkBlock({ hasContactEmail: true, hasLiveToken: false })).toBe('has_contact_email');
    });
});

describe('canRevealTrackingLink', () => {
    it('needs the right role AND the right customer', () => {
        expect(canRevealTrackingLink(RoleEnum.COORDINATOR, WITHOUT_EMAIL)).toBe(true);
        expect(canRevealTrackingLink(RoleEnum.SUPERVISOR, WITHOUT_EMAIL)).toBe(false);
        expect(canRevealTrackingLink(RoleEnum.COORDINATOR, { hasContactEmail: true, hasLiveToken: true })).toBe(false);
        expect(canRevealTrackingLink(RoleEnum.COORDINATOR, { hasContactEmail: false, hasLiveToken: false })).toBe(false);
        expect(canRevealTrackingLink(RoleEnum.ROOT, WITHOUT_EMAIL)).toBe(true);
    });
});
