import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Put } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { SetSkillDto, UpdateMeDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user.id, dto);
  }

  @Get('skills')
  skills(@CurrentUser() user: AuthUser) {
    return this.users.mySkills(user.id);
  }

  @Put('skills/:skillId')
  setSkill(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string, @Body() dto: SetSkillDto) {
    return this.users.setSkill(user.id, skillId, dto);
  }

  @Delete('skills/:skillId')
  @HttpCode(204)
  removeSkill(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.users.removeSkill(user.id, skillId);
  }
}

