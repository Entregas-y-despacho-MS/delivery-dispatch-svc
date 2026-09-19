import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { UserDto } from './user.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllUsersResponseDto extends PaginationResponseDto<UserDto> {
    @ApiProperty({ type: [UserDto] })
    declare data: UserDto[];
}
