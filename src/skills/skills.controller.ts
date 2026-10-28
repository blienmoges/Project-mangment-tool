import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';
import { SkillsService } from './skills.service';

@Controller()
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get('workspaces/:workspaceId/skills')
  list(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.skills.list(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/skills')
  create(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CreateSkillDto) {
    return this.skills.create(workspaceId, user.id, dto);
  }

  @Patch('skills/:skillId')
  update(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string, @Body() dto: UpdateSkillDto) {
    return this.skills.update(skillId, user.id, dto);
  }

  @Delete('skills/:skillId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.skills.remove(skillId, user.id);
  }
}

