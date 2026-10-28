import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max,
  MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { PriorityLevel, SkillLevel } from '@prisma/client';
import { toBoolean } from '../../common/query';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a date such as 2027-02-26';

export class RequiredSkillDto {
  @IsUUID()
  skillId: string;

  @ApiProperty({ enum: SkillLevel })
  @IsEnum(SkillLevel)
  minLevel: SkillLevel;
}

class TaskFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  /** null removes the task from its phase (PATCH). */
  @IsOptional()
  @IsUUID()
  phaseId?: string | null;

  /** null moves the task to the backlog (PATCH). */
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
  @Max(999)
  storyPoints?: number | null;

  @IsOptional()
  @Matches(DATE, { message: `startDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  startDate?: string | null;

  @IsOptional()
  @Matches(DATE, { message: `dueDate ${DATE_MESSAGE}` })
  @IsISO8601({ strict: true })
  dueDate?: string | null;

  /** Custom field values: { "<fieldId>": value }. null clears a value. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class CreateTaskDto extends TaskFieldsDto {
  @IsString()
  @Length(1, 200)
  title: string;

  /** Makes this a subtask (one level deep). */
  @IsOptional()
  @IsUUID()
  parentTaskId?: string;

  /** Starting status; defaults to the first Not started status. Cannot be a closed status. */
  @IsOptional()
  @IsUUID()
  statusId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RequiredSkillDto)
  requiredSkills?: RequiredSkillDto[];
}

export class UpdateTaskDto extends TaskFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  /** Make it a subtask of another task, or null to make it a top-level task. */
  @IsOptional()
  @IsUUID()
  parentTaskId?: string | null;
}

export class TaskListQuery {
  /** A status id, or a category: not_started, active, review, closed. */
  @IsOptional()
  @IsString()
  status?: string;

  /** A user id, "me", or "none" for unassigned tasks. */
  @IsOptional()
  @ValidateIf((o) => o.assigneeId !== 'me' && o.assigneeId !== 'none')
  @IsUUID()
  assigneeId?: string;

  /** A phase id, or "none". */
  @IsOptional()
  @ValidateIf((o) => o.phaseId !== 'none')
  @IsUUID()
  phaseId?: string;

  /** A sprint id, or "backlog" for tasks not in a sprint. */
  @IsOptional()
  @ValidateIf((o) => o.sprintId !== 'backlog')
  @IsUUID()
  sprintId?: string;

  /** Only tasks of this parent (its subtasks). */
  @IsOptional()
  @IsUUID()
  parentTaskId?: string;

  /** true: leave subtasks out (top-level tasks only). */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  topLevel?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ enum: PriorityLevel })
  @IsOptional()
  @IsEnum(PriorityLevel)
  priority?: PriorityLevel;

  /** Text search in title and description, or a short ID such as MBA-42. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Custom field filter (FR-11.6): fieldId plus fieldValue. */
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fieldValue?: string;

  /** dueDate, priority, createdAt, updatedAt or number; prefix with - for descending (default: number). */
  @IsOptional()
  @IsIn(['dueDate', '-dueDate', 'priority', '-priority', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'number', '-number'])
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class AddDependencyDto {
  /** The task this one must wait for (same project). */
  @IsUUID()
  dependsOnTaskId: string;
}

export class SuggestionsQuery {
  /** Only members of this team (FR-10.6). */
  @IsOptional()
  @IsUUID()
  teamId?: string;

  /** Also consider the project's own Project Manager. */
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
  /** A project member who is not a Guest; null removes the assignee. */
  @ValidateIf((o) => o.userId !== null)
  @IsUUID()
  userId: string | null;
}

export class ConcernDto {
  @IsString()
  @Length(1, 1000)
  note: string;
}

export class MoveStatusDto {
  @IsUUID()
  statusId: string;
}

export class OptionalStatusDto {
  /** Optional target status; see each action for which categories are allowed. */
  @IsOptional()
  @IsUUID()
  statusId?: string;
}

export class RequestChangesDto extends OptionalStatusDto {
  /** What needs to change; saved as a comment on the task. */
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  note?: string;
}

export class MyTasksQuery {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class ByKeyQuery {
  /** Needed only if you belong to several workspaces that use the same key prefix. */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}
