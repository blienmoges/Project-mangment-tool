import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min,
} from 'class-validator';
import { PriorityLevel, ProjectRole, ProjectStatus } from '@prisma/client';
import { toBoolean } from '../../common/query';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a date such as 2027-02-26';

// ───────────── Projects ─────────────

export class CreateProjectDto {
  @IsString()
  @Length(2, 120)
  name: string;

  /** 2 to 5 capital letters or digits, starting with a letter (MBA → task IDs MBA-1, MBA-2). Cannot be changed later. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9]{1,4}$/, { message: 'keyPrefix must be 2 to 5 letters or digits, starting with a letter, for example MBA' })
  keyPrefix: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Matches(DATE, { message: `startDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  startDate: string;

  /** Must be after startDate. */
  @Matches(DATE, { message: `endDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  endDate: string;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  /** The Project Manager; defaults to the caller. Must be someone allowed to create projects. */
  @IsOptional()
  @IsUUID()
  managerId?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  /** Send null or "" to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  /** archived makes the project read-only; setting another status restores it. */
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  @IsOptional()
  @Matches(DATE, { message: `startDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  startDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `endDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  endDate?: string;
}

export class ProjectListQuery {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;
}

export class MoveProjectDto {
  @IsUUID()
  spaceId: string;

  /** Optional: { "<old status id>": "<new status id>" }. Statuses not listed are matched by name, then by category. */
  @IsOptional()
  @IsObject()
  statusMapping?: Record<string, string>;

  /** true: report what would change without changing anything. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

// ───────────── Members ─────────────

export class AddProjectMembersDto {
  /** People to add. Workspace Guests join with the read-only guest role. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  userIds?: string[];

  /** Whole teams: current members join now, future members join automatically (FR-10.3). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  teamIds?: string[];
}

export class ChangeProjectRoleDto {
  /** project_manager makes this person the PM; the current PM becomes a Team Member. */
  @ApiProperty({ enum: ProjectRole })
  @IsEnum(ProjectRole)
  role: ProjectRole;
}

// ───────────── Phases ─────────────

export class CreatePhaseDto {
  @IsString()
  @Length(1, 80)
  name: string;

  @IsOptional()
  @Matches(DATE, { message: `dueDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  dueDate?: string;

  /** 0-based place among the project's phases; leave it out to add at the end. */
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdatePhaseDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  /** Send null to remove the due date. */
  @IsOptional()
  @Matches(DATE, { message: `dueDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class DeletePhaseQuery {
  /** Phase of the same project that receives the tasks; without it they are left without a phase. */
  @IsOptional()
  @IsUUID()
  moveTasksTo?: string;
}
