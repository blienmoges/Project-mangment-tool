import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(2, 120)
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  /** Token from the invitation link; joins the workspace straight away. */
  @IsOptional()
  @IsString()
  invitationToken?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}


export class LoginTwoFactorDto {
  /** From the login answer { twoFactorRequired, challengeId }; valid 5 minutes. */
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  /** The 6-digit code from the authenticator app, or one of the backup codes (like k7m2-qx4pa). */
  @IsString()
  @Length(6, 12)
  code: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  /** The token from the link in the email. */
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class TwoFactorCodeDto {
  @IsString()
  @Length(6, 7)
  code: string;
}

export class PasswordDto {
  @IsString()
  @IsNotEmpty()
  password: string;
}
