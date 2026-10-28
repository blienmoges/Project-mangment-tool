import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { AppException } from './app-exception';

const DEFAULT_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** Turns every error into the standard { error: { code, message } } shape. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppException) {
      res.status(exception.getStatus()).json({ error: exception.body });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const msg = typeof raw === 'string' ? raw : ((raw as { message?: string | string[] }).message ?? exception.message);
      res.status(status).json({ error: { code: DEFAULT_CODES[status] ?? 'ERROR', message: Array.isArray(msg) ? msg.join('; ') : msg } });
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'A record with these details already exists.' } });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
        return;
      }
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } });
  }
}

