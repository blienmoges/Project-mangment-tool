import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateSkillDto {
  @IsString()
  @Length(1, 60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;
}

export class UpdateSkillDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;
}

