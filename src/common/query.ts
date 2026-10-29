import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** Turns ?flag=true / ?flag=1 into a boolean. */
export const toBoolean = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class IncludeArchivedQuery {
  /** Also return archived records. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}
