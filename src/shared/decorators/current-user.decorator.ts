import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Extracts the authenticated user from the request (populated by Passport after JwtStrategy.validate()).
// Usage: @CurrentUser() user: AuthUser  →  full object
//        @CurrentUser('id') userId: number  →  single field
export const CurrentUser = createParamDecorator(
    (field: string | undefined, ctx: ExecutionContext) => {
        const user = ctx.switchToHttp().getRequest().user;
        return field ? user?.[field] : user;
    },
);
