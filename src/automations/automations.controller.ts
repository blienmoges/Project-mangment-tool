import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AutomationsService } from './automations.service';

export class SetRuleDto {
  @IsBoolean()
  enabled: boolean;
}

@Controller('projects/:projectId/automations')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  /** The ready-made rules and whether each is on. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.automations.list(projectId, user.id);
  }

  /** Turn a rule on or off: review_notify, subtasks_done, critical_priority or pr_merged. */
  @Patch(':ruleKey')
  set(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Param('ruleKey') ruleKey: string, @Body() dto: SetRuleDto) {
    return this.automations.set(projectId, user.id, ruleKey, dto.enabled);
  }
}
