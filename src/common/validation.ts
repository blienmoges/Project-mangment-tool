import { ValidationError } from 'class-validator';
import { Errors } from './app-exception';

/** Converts class-validator errors into VALIDATION_FAILED with one message per field. */
export function validationExceptionFactory(errors: ValidationError[]) {
  const fields: Record<string, string> = {};
  const walk = (list: ValidationError[], prefix = '') =>
    list.forEach((e) => {
      const key = prefix ? `${prefix}.${e.property}` : e.property;
      if (e.constraints) fields[key] = Object.values(e.constraints)[0];
      if (e.children?.length) walk(e.children, key);
    });
  walk(errors);
  return Errors.validation(fields);
}


/** Validates a request body that is an array of DTOs (the global ValidationPipe skips arrays). */
export async function validateArray<T extends object>(body: unknown, cls: new () => T, max = 50): Promise<T[]> {
  const { plainToInstance } = await import('class-transformer');
  const { validate } = await import('class-validator');
  if (!Array.isArray(body)) throw Errors.validation({ body: 'must be an array' });
  if (body.length > max) throw Errors.validation({ body: `may contain at most ${max} items` });
  const items = body.map((b) => plainToInstance(cls, b));
  const fields: Record<string, string> = {};
  for (const [i, item] of items.entries()) {
    if (typeof item !== 'object' || item === null) { fields[`${i}`] = 'must be an object'; continue; }
    const errors = await validate(item, { whitelist: true, forbidNonWhitelisted: true });
    for (const e of errors) if (e.constraints) fields[`${i}.${e.property}`] = Object.values(e.constraints)[0];
  }
  if (Object.keys(fields).length) throw Errors.validation(fields);
  return items;
}
