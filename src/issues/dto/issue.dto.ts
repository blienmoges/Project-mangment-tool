import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsEnum, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { IssueStatus, IssueType, SeverityLevel } from '@prisma/client';
import { PageQuery } from '../../common/paging';

export class CreateIssueDto {
  @IsString()
  @Length(1, 200)
  title: string;

  @IsOptional() @IsString() @MaxLength(20000)
  description?: string;

  /** bug, blocker, question or risk. A blocker linked to a task blocks it until resolved. */
  @ApiProperty({ enum: IssueType })
  @IsEnum(IssueType)
  type: IssueType;

  /** low, medium, high or critical. Critical alerts the whole project team, including by SMS. */
  @ApiProperty({ enum: SeverityLevel })
  @IsEnum(SeverityLevel)
  severity: SeverityLevel;

  /** The affected task (same project). */
  @IsOptional() @IsUUID()
  taskId?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  stepsToReproduce?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  expectedResult?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  actualResult?: string;

  /** Browser or device, for example "Chrome 130" or "Samsung A54". */
  @IsOptional() @IsString() @MaxLength(80)
  device?: string;

  @IsOptional() @IsString() @MaxLength(80)
  operatingSystem?: string;

  @IsOptional() @IsString() @MaxLength(80)
  appVersion?: string;
}

/** Send null to clear an optional field. */
export class UpdateIssueDto {
  @IsOptional() @IsString() @Length(1, 200)
  title?: string;

  @IsOptional() @IsString() @MaxLength(20000)
  description?: string | null;

  @ApiPropertyOptional({ enum: IssueType })
  @IsOptional() @IsEnum(IssueType)
  type?: IssueType;

  @ApiPropertyOptional({ enum: SeverityLevel })
  @IsOptional() @IsEnum(SeverityLevel)
  severity?: SeverityLevel;

  @IsOptional() @IsUUID()
  taskId?: string | null;

  @IsOptional() @IsString() @MaxLength(5000)
  stepsToReproduce?: string | null;

  @IsOptional() @IsString() @MaxLength(5000)
  expectedResult?: string | null;

  @IsOptional() @IsString() @MaxLength(5000)
  actualResult?: string | null;

  @IsOptional() @IsString() @MaxLength(80)
  device?: string | null;

  @IsOptional() @IsString() @MaxLength(80)
  operatingSystem?: string | null;

  @IsOptional() @IsString() @MaxLength(80)
  appVersion?: string | null;
}

export class AssignIssueDto {
  /** A project member who is not a Guest; null removes the fixer. */
  @IsDefined()
  @ValidateIf((o) => o.userId !== null)
  @IsUUID()
  userId: string | null;
}

export class IssueStatusDto {
  @ApiProperty({ enum: IssueStatus })
  @IsEnum(IssueStatus)
  status: IssueStatus;
}

const UUID_OR = (w: string) => new RegExp(`^(${w}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, 'i');

export class IssueListQuery extends PageQuery {
  /** A status, or "unresolved" for open and in-progress issues. */
  @IsOptional()
  @Matches(/^(open|in_progress|resolved|closed|unresolved)$/, { message: 'status must be open, in_progress, resolved, closed or unresolved' })
  status?: string;

  @ApiPropertyOptional({ enum: IssueType })
  @IsOptional() @IsEnum(IssueType)
  type?: IssueType;

  @ApiPropertyOptional({ enum: SeverityLevel })
  @IsOptional() @IsEnum(SeverityLevel)
  severity?: SeverityLevel;

  @IsOptional() @IsUUID()
  taskId?: string;

  /** A user id, "me", or "none" for issues nobody is fixing yet. */
  @IsOptional()
  @Matches(UUID_OR('me|none'), { message: 'assigneeId must be a user id, "me" or "none"' })
  assigneeId?: string;

  /** Searches titles and descriptions. */
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;
}
