import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { toBoolean } from '../../common/query';

export class CreateTeamDto {
  @IsString()
  @Length(2, 80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** People to put in the team straight away (workspace Members or Admins, not Guests). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  memberIds?: string[];
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  /** Send null or "" to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class AddTeamMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  userIds: string[];
}

export class DeleteTeamQuery {
  /**
   * true: people keep the space and project access they had through the team (as direct members).
   * false (default): access they had only through this team is removed.
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  keepAccess?: boolean;
}
