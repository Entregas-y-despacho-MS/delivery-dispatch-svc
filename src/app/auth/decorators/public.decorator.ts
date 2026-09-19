import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../guards/jwt-auth.guard.js';

// Marks a route as public — skips JwtAuthGuard.
// Only has effect when JwtAuthGuard is registered as APP_GUARD in AppModule.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
