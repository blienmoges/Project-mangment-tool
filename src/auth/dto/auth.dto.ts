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

