import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AuthService } from './auth.service';
import { ChangePasswordDto, PasswordDto, TwoFactorCodeDto } from './dto/auth.dto';
import { TwoFactorService } from './two-factor.service';

/** Password and two-factor settings of the signed-in person. */
@Controller('me')
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /** Change password (current password required). Other sessions are signed out; this one stays. */
  @Patch('password')
  @HttpCode(204)
  password(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, req.cookies?.refresh_token);
  }

  /** Start two-factor setup: { qrCode (PNG data URL), otpauthUrl, secret } to scan or type into the app. */
  @Post('2fa/enable')
  @HttpCode(200)
  enable(@CurrentUser() user: AuthUser) {
    return this.twoFactor.start(user.id);
  }

  /** Confirm with the first 6-digit code from the app; two-factor login is on from now. */
  @Post('2fa/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.twoFactor.confirm(user.id, dto.code);
  }

  /** Whether two-factor login is on, and how many backup codes are left. */
  @Get('2fa')
  status(@CurrentUser() user: AuthUser) {
    return this.twoFactor.status(user.id);
  }

  /** New backup codes (the old ones stop working): { "password": "..." }. */
  @Post('2fa/backup-codes')
  @HttpCode(200)
  async backupCodes(@CurrentUser() user: AuthUser, @Body() dto: PasswordDto) {
    await this.auth.checkPassword(user.id, dto.password);
    return this.twoFactor.regenerateBackupCodes(user.id);
  }

  /** Switch two-factor login off: { "password": "..." }. */
  @Delete('2fa')
  @HttpCode(204)
  async disable(@CurrentUser() user: AuthUser, @Body() dto: PasswordDto) {
    await this.auth.checkPassword(user.id, dto.password);
    await this.twoFactor.disable(user.id);
  }
}
