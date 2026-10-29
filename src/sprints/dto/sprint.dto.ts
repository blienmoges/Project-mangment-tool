import { IsISO8601, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateMsg = (f: string) => ({ message: `${f} must be a date such as 2027-02-26` });

export class CreateSprintDto {
  @IsString()
  @Length(1, 60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goal?: string;

  /** Defaults to the day after the latest sprint ends, or today. */
  @IsOptional()
  @Matches(DATE, dateMsg('startDate'))
  @IsISO8601({ strict: true })
  startDate?: string;

  /** Defaults to two weeks: 13 days after startDate. Must be after startDate. */
  @IsOptional()
  @Matches(DATE, dateMsg('endDate'))
  @IsISO8601({ strict: true })
  endDate?: string;
}

export class UpdateSprintDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  /** Send null or "" to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goal?: string | null;

  /** Not for completed sprints. */
  @IsOptional()
  @Matches(DATE, dateMsg('startDate'))
  @IsISO8601({ strict: true })
  startDate?: string;

  @IsOptional()
  @Matches(DATE, dateMsg('endDate'))
  @IsISO8601({ strict: true })
  endDate?: string;
}

export class CompleteSprintDto {
  /** "backlog", or the id of a planned sprint of the same project, for the tasks that are not done. */
  @Matches(/^(backlog|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, { message: 'moveUnfinishedTo must be "backlog" or a sprint id' })
  moveUnfinishedTo: string;
}
