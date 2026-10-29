import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** ?limit= (default 25, maximum 100) and ?cursor= (API Design, "Lists"). */
export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** The nextCursor of the previous page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/** Prisma arguments for one page: fetch one extra row to know whether more exist. */
export function pageArgs(q: PageQuery) {
  const take = q.limit ?? 25;
  return { take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) };
}

/** Cuts the extra row and returns { data, nextCursor }. */
export function toPage<T extends { id: string }, R>(rows: T[], q: PageQuery, map: (row: T) => R) {
  const take = q.limit ?? 25;
  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  return { data: page.map(map), nextCursor: more ? page[page.length - 1].id : null };
}
