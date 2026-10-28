import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { FieldType, SpaceVisibility, StatusCategory } from '@prisma/client';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const HEX_MESSAGE = 'color must be a hex color such as #3B82F6';

// ───────────── Spaces ─────────────

export class CreateSpaceDto {
  @IsString()
  @Length(2, 80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** open (default): every workspace Member sees it. private: only its members and the Workspace Admin. */
  @ApiPropertyOptional({ enum: SpaceVisibility })
  @IsOptional()
  @IsEnum(SpaceVisibility)
  visibility?: SpaceVisibility;
}

export class UpdateSpaceDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  /** Send null or "" to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ enum: SpaceVisibility })
  @IsOptional()
  @IsEnum(SpaceVisibility)
  visibility?: SpaceVisibility;

  /** true archives the space (its projects become read-only); false restores it. */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class AddSpaceMembersDto {
  /** People to add directly (Guests are allowed: this is how they get read-only access). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  userIds?: string[];

  /** Whole teams: current members join now, future members join automatically. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  teamIds?: string[];
}

// ───────────── Workflow statuses ─────────────

export class CreateStatusDto {
  @IsString()
  @Length(1, 40)
  name: string;

  @IsOptional()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  color?: string;

  /** not_started, active, review or closed. Only the approve action can move a task into a closed status. */
  @ApiProperty({ enum: StatusCategory })
  @IsEnum(StatusCategory)
  category: StatusCategory;

  /**
   * 0-based place in the workflow. It must fall inside the block of its category, because statuses are
   * always ordered Not started → Active → Review → Closed. Leave it out to add the status at the end of its block.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdateStatusDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  name?: string;

  /** Send null to remove the color. */
  @IsOptional()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  color?: string | null;

  /** Only allowed while no task uses the status. */
  @ApiPropertyOptional({ enum: StatusCategory })
  @IsOptional()
  @IsEnum(StatusCategory)
  category?: StatusCategory;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class DeleteStatusQuery {
  /** Status (same space, same category) that receives the tasks currently in the deleted status. */
  @IsOptional()
  @IsUUID()
  moveTasksTo?: string;
}

// ───────────── Custom fields ─────────────

export class DropdownOptionDto {
  /** Keep the id of an existing choice when editing; new choices get one from the server. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  id?: string;

  @IsString()
  @Length(1, 60)
  label: string;

  @IsOptional()
  @Matches(HEX_COLOR, { message: HEX_MESSAGE })
  color?: string;
}

export class CreateCustomFieldDto {
  @IsString()
  @Length(1, 60)
  name: string;

  /** text, number, dropdown, checkbox or date. Cannot be changed later. */
  @ApiProperty({ enum: FieldType })
  @IsEnum(FieldType)
  fieldType: FieldType;

  /** Choices; required for dropdown fields and not allowed for other types. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DropdownOptionDto)
  options?: DropdownOptionDto[];

  /** 0-based place among the space's fields; leave it out to add at the end. */
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdateCustomFieldDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  /** The full new list of choices (dropdown only). Values that used a removed choice are cleared from tasks. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DropdownOptionDto)
  options?: DropdownOptionDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
