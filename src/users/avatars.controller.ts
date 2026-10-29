import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/decorators';
import { UsersService } from './users.service';

@Controller('avatars')
export class AvatarsController {
  constructor(private readonly users: UsersService) {}

  /** A profile photo (no login needed, so it works in <img> tags). */
  @Public()
  @Get(':name')
  get(@Param('name') name: string, @Res() res: Response) {
    return this.users.sendAvatar(name, res);
  }
}
