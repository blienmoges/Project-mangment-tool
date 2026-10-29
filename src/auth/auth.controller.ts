import { Body, Controller, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request, Response } from 'express';
import { Public } from '../common/decorators';
import { AuthService, IssuedTokens, REFRESH_TOKEN_DAYS } from './auth.service';
import { ForgotPasswordDto, LoginDto, LoginTwoFactorDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

const REFRESH_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** The refresh token travels only in a secure HTTP-only cookie, never in JavaScript. */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    };
  }

  private send(res: Response, tokens: IssuedTokens, extra: object = {}) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, this.cookieOptions());
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, ...extra };
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Headers('user-agent') ua: string, @Res({ passthrough: true }) res: Response) {
    const { tokens, user } = await this.auth.register(dto, ua);
    return this.send(res, tokens, { user });
  }

  /** Email and password. Returns tokens, or { twoFactorRequired: true, challengeId } when two-factor login is on. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Headers('user-agent') ua: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, ua, req.ip);
    if ('twoFactorRequired' in result) return result;
    return this.send(res, result.tokens, { user: result.user });
  }

  /** Second step: { challengeId, code } with the 6-digit code from the authenticator app. */
  @Public()
  @Post('login/2fa')
  @HttpCode(200)
  async loginTwoFactor(@Body() dto: LoginTwoFactorDto, @Headers('user-agent') ua: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { tokens, ...rest } = await this.auth.loginTwoFactor(dto.challengeId, dto.code, ua, req.ip);
    return this.send(res, tokens, rest); // { user } and, after a backup code, { backupCodesLeft }
  }

  /** Sends a reset link by email. Always answers the same, whether or not the email has an account. */
  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.forgotPassword(dto.email, req.ip);
  }

  /** Sets a new password with the token from the email; signs the account out everywhere. */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Headers('user-agent') ua: string, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], ua);
    return this.send(res, tokens);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    const { maxAge, ...opts } = this.cookieOptions();
    res.clearCookie(REFRESH_COOKIE, opts);
  }
}

