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

