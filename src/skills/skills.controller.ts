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

  /** Mark a person's skill level as verified (Admin, or PM of a project they work in). */
  @Post('users/:userId/skills/:skillId/verify')
  @HttpCode(200)
  verify(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.skills.verify(userId, skillId, user.id, true);
  }

  /** Withdraw a verification. */
  @Delete('users/:userId/skills/:skillId/verify')
  @HttpCode(200)
  unverify(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.skills.verify(userId, skillId, user.id, false);
  }

  /** A colleague's skills in this workspace, with who verified each. */
  @Get('workspaces/:workspaceId/members/:userId/skills')
  memberSkills(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.skills.memberSkills(workspaceId, userId, user.id);
  }

  @Delete('skills/:skillId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.skills.remove(skillId, user.id);
  }
}

