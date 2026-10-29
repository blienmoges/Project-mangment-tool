import { HttpException, HttpStatus } from '@nestjs/common';

/** Shape of every error the API returns: { "error": { code, message, fields? } } (API Design, section 9). */
export interface ErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class AppException extends HttpException {
  constructor(status: number, public readonly body: ErrorBody) {
    super(body, status);
  }
}

/** Ready-made errors so every module answers the same way. */
export const Errors = {
  validation: (fields: Record<string, string>, message = 'Some fields are missing or invalid.') =>
    new AppException(HttpStatus.BAD_REQUEST, { code: 'VALIDATION_FAILED', message, fields }),
  unauthenticated: (message = 'Please log in again.') =>
    new AppException(HttpStatus.UNAUTHORIZED, { code: 'UNAUTHENTICATED', message }),
  invalidCredentials: () =>
    new AppException(HttpStatus.UNAUTHORIZED, { code: 'INVALID_CREDENTIALS', message: 'The email or password is incorrect.' }),
  forbidden: (message = 'Your role does not allow this action.', code = 'FORBIDDEN') =>
    new AppException(HttpStatus.FORBIDDEN, { code, message }),
  notFound: (what = 'Record') => new AppException(HttpStatus.NOT_FOUND, { code: 'NOT_FOUND', message: `${what} not found.` }),
  conflict: (code: string, message: string) => new AppException(HttpStatus.CONFLICT, { code, message }),
  gone: (code: string, message: string) => new AppException(HttpStatus.GONE, { code, message }),
  /** 403 with a specific code, e.g. APPROVAL_REQUIRED. */
  forbiddenCode: (code: string, message: string) => new AppException(HttpStatus.FORBIDDEN, { code, message }),
  /** 422 with a specific code, e.g. NOT_PROJECT_MEMBER. */
  unprocessable: (code: string, message: string) => new AppException(HttpStatus.UNPROCESSABLE_ENTITY, { code, message }),
};

