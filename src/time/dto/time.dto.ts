import { IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ManualEntryDto {
  /** 1 to 1440 minutes (one day). */
  @IsInt()
  @Min(1)
  @Max(1440)
  minutes: number;

  /** The day the work was done (not in the future). */
  @Matches(DATE, { message: 'date must be a date such as 2027-02-10' })
  @IsISO8601({ strict: true })
  date: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateEntryDto {
  @IsOptional() @IsInt() @Min(1) @Max(1440)
  minutes?: number;

  @IsOptional()
  @Matches(DATE, { message: 'date must be a date such as 2027-02-10' })
  @IsISO8601({ strict: true })
  date?: string;

  /** Send null or "" to clear it. */
  @IsOptional() @IsString() @MaxLength(500)
  note?: string | null;
}

export class StartTimerDto {
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class TimeReportQuery {
  /** First day included (default: the project's start). */
  @IsOptional()
  @Matches(DATE, { message: 'from must be a date such as 2027-02-01' })
  @IsISO8601({ strict: true })
  from?: string;

  /** Last day included (default: today). */
  @IsOptional()
  @Matches(DATE, { message: 'to must be a date such as 2027-02-28' })
  @IsISO8601({ strict: true })
  to?: string;

  /** csv downloads the entries as a spreadsheet file. */
  @IsOptional()
  @Matches(/^(json|csv)$/, { message: 'format must be json or csv' })
  format?: 'json' | 'csv';
}
