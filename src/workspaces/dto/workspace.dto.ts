import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsTimeZone, IsUrl, Length, Matches, Max, Min } from 'class-validator';
import { WorkspaceRole } from '@prisma/client';

export class CreateWorkspaceDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsOptional()
  @Matches(/^[a-z0-9-]{3,60}$/, { message: 'slug may only contain lower-case letters, numbers and dashes (3 to 60 characters)' })
  slug?: string;
}

export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  name?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsIn(['en', 'am'])
  defaultLanguage?: string;

  /** IANA time zone, for example Africa/Addis_Ababa. */
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workingDays?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(30, { each: true })
  reminderDays?: number[];
}

export class ChangeRoleDto {
  @IsOptional()
  @IsEnum(WorkspaceRole)
  role?: WorkspaceRole;

  /** Whether this Member may create projects (and so become a Project Manager). */
  @IsOptional()
  @IsBoolean()
  canManageProjects?: boolean;
}

export class CreateInvitationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  emails: string[];

  @IsEnum(WorkspaceRole)
  role: WorkspaceRole;
}

