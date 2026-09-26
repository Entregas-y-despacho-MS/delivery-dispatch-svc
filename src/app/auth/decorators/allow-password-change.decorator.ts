import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_KEY = 'allowWhilePasswordChangeRequired';

/**
 * While an account must change its password (RF-A25) every endpoint answers 403 PASSWORD_CHANGE_REQUIRED,
 * except the ones marked with this: changing the password itself and logging out.
 */
export const AllowWhilePasswordChangeRequired = () => SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
