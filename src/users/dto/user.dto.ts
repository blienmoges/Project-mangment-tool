import { IsEnum, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { SkillLevel } from '@prisma/client';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @IsOptional()
  @Matches(/^\+?[0-9 ]{7,20}$/, { message: 'phone must be a valid phone number, for example +251 911 000 101' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  bio?: string;

  @IsOptional()
  @IsIn(['en', 'am'])
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  weeklyCapacityHours?: number;
}

export class SetSkillDto {
  @IsEnum(SkillLevel)
  level: SkillLevel;
}

