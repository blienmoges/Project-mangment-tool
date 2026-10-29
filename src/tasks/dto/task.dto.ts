import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsEnum, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { PriorityLevel, SkillLevel, StatusCategory } from '@prisma/client';
import { PageQuery } from '../../common/paging';
import { toBoolean } from '../../common/query';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateMsg = (f: string) => ({ message: `${f} must be a date such as 2027-02-26` });
const UUID_OR = (words: string[]) => new RegExp(`^(${words.join('|')}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, 'i');

export class RequiredSkillDto {
  @IsUUID()
  skillId: string;

  @ApiProperty({ enum: SkillLevel })
  @IsEnum(SkillLevel)
  minLevel: SkillLevel;
}

export class CreateTaskDto {
  @IsString()
  @Length(1, 200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @IsUUID()
  phaseId?: string;

  /** A planned or active sprint of the same project; leave it out to put the task in the backlog. */
  @IsOptional()
  @IsUUID()
  sprintId?: string;

  /** Makes this a subtask (one level deep). Phase and sprint default to the parent's. */
  @IsOptional()
  @IsUUID()
  parentTaskId?: string;

  /** Starting status (not a closed one); defaults to the first Not started status of the space. */
  @IsOptional()
  @IsUUID()
  statusId?: string;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999)
  estimatedHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  storyPoints?: number;

  @IsOptional()
  @Matches(DATE, dateMsg('startDate'))
  @IsISO8601({ strict: true })
  startDate?: string;

  /** On or after startDate. */
  @IsOptional()
  @Matches(DATE, dateMsg('dueDate'))
  @IsISO8601({ strict: true })
  dueDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RequiredSkillDto)
  requiredSkills?: RequiredSkillDto[];

  /** { "<fieldId>": value }. Values: text → string, number, checkbox → true/false, date → "2027-02-26", dropdown → choice id. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

/** Status and assignee have their own action endpoints; the parent and the key cannot change. Send null to clear a field. */
export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  phaseId?: string | null;

  /** null moves the task to the backlog. */
  @IsOptional()
  @IsUUID()
  sprintId?: string | null;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999)
  estimatedHours?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  storyPoints?: number | null;

  @IsOptional()
  @Matches(DATE, dateMsg('startDate'))
  @IsISO8601({ strict: true })
  startDate?: string | null;

  /** Changing it restarts the reminders and the overdue alert for the new date. */
  @IsOptional()
  @Matches(DATE, dateMsg('dueDate'))
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  /** Only the fields sent change; null clears a value. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class AddDependencyDto {
  /** A task of the same project that must be finished before this one can start. */
  @IsUUID()
  dependsOnTaskId: string;
}

export const TASK_SORTS = ['dueDate', '-dueDate', 'priority', '-priority', 'number', '-number', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt'] as const;

export class TaskListQuery extends PageQuery {
  /** A status id, or a category: not_started, active, review, closed. */
  @IsOptional()
  @IsString()
  @Matches(UUID_OR(Object.values(StatusCategory)), { message: 'status must be a status id or one of not_started, active, review, closed' })
  status?: string;

  /** A user id, "me", or "none" for unassigned tasks. */
  @IsOptional()
  @Matches(UUID_OR(['me', 'none']), { message: 'assigneeId must be a user id, "me" or "none"' })
  assigneeId?: string;

  /** A phase id, or "none". */
  @IsOptional()
  @Matches(UUID_OR(['none']), { message: 'phaseId must be a phase id or "none"' })
  phaseId?: string;

  /** A sprint id, or "backlog" for tasks not in any sprint. */
  @IsOptional()
  @Matches(UUID_OR(['backlog', 'none']), { message: 'sprintId must be a sprint id or "backlog"' })
  sprintId?: string;

  /** A task id (its subtasks), or "none" for top-level tasks only. */
  @IsOptional()
  @Matches(UUID_OR(['none']), { message: 'parentTaskId must be a task id or "none"' })
  parentTaskId?: string;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;

  /** Searches titles and descriptions; a short ID such as MBA-42 finds that task. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Custom field filter: ?cf[<fieldId>]=value (FR-11.6). */
  @IsOptional()
  @IsObject()
  cf?: Record<string, string>;

  /** Field to sort by; a leading "-" sorts descending. Default: number. */
  @IsOptional()
  @IsIn(TASK_SORTS)
  sort?: (typeof TASK_SORTS)[number];
}

export class MyTasksQuery {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class ByKeyQuery {
  /** Needed only when you belong to several workspaces that use the same key prefix. */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

// ───────────── Assignment ─────────────

export class SuggestionsQuery {
  /** Only members of this team (FR-10.6). */
  @IsOptional()
  @IsUUID()
  teamId?: string;

  /** Also rank the project's own PM. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeManager?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AssignDto {
  /** A project member who is not a Guest; null unassigns the task. */
  @IsDefined()
  @ValidateIf((o) => o.userId !== null)
  @IsUUID()
  userId: string | null;
}

export class ConcernDto {
  @IsString()
  @Length(1, 1000)
  note: string;
}

// ───────────── Status changes ─────────────

export class MoveStatusDto {
  @IsUUID()
  statusId: string;
}

export class ApproveDto {
  /** A closed status (for example Done or Won't do); defaults to the first closed status. */
  @IsOptional()
  @IsUUID()
  statusId?: string;
}

export class RequestChangesDto {
  /** What needs to change; also added to the task's comments. */
  @IsString()
  @Length(1, 2000)
  note: string;

  /** Status to return to; defaults to the first Active status. */
  @IsOptional()
  @IsUUID()
  statusId?: string;
}

export class ReopenDto {
  /** Status to reopen into; defaults to the first Active status. */
  @IsOptional()
  @IsUUID()
  statusId?: string;
}
