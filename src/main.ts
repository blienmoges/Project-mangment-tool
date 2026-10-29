import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { validationExceptionFactory } from './common/validation';

async function bootstrap() {
  // rawBody: GitHub webhooks are verified against the exact bytes GitHub signed.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  // Behind a proxy or load balancer, TRUST_PROXY=1 makes rate limits see the real client address.
  if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.useWebSocketAdapter(new WsAdapter(app)); // live notifications at /ws
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop fields the endpoint does not expect
      forbidNonWhitelisted: true, // ...and report them as errors
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks(); // closes queues and workers cleanly

  // OpenAPI specification: interactive page at /api/docs, JSON file at /api/docs-json
  const openApi = new DocumentBuilder()
    .setTitle('Project Management Platform API')
    .setDescription('Generated from the code, so it always matches what the server does. See the API Design document for the rules behind each endpoint.')
    .setVersion('1.0')
    .addBearerAuth()
    .addSecurityRequirements('bearer')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi), { jsonDocumentUrl: 'api/docs-json' });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API running at http://localhost:${port}/api/v1 (docs: http://localhost:${port}/api/docs, WebSocket: ws://localhost:${port}/ws)`, 'Bootstrap');
}
bootstrap();

