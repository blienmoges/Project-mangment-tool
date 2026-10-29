import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [
    WorkspacesModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_ACCESS_SECRET');
        if (!secret || secret.length < 32) throw new Error('JWT_ACCESS_SECRET must be set in .env and be at least 32 characters long.');
        return { secret };
      },
    }),
  ],
  controllers: [AuthController, AccountController],
  providers: [AuthService, TwoFactorService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}

