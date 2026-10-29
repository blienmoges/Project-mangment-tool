import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { IsDefined, IsUUID } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CustomRulesService } from './custom-rules.service';

export class ValidateRuleDto {
  @IsUUID()
  projectId: string;

  /** The rule to check: { name, trigger, conditions, actions }. */
  @IsDefined()
  rule: unknown;
}

const RULE_EXAMPLE = {
  name: 'Tell QA when a task enters Testing',
  trigger: { event: 'task.status_changed', toStatusId: '<status id>' },
  conditions: [{ field: 'task.priority', operator: 'in', value: ['medium', 'high'] }],
  actions: [{ type: 'notify', recipients: { teamId: '<QA team id>' }, message: '{task} is ready for testing.' }],
};

@Controller()
export class CustomRulesController {
  constructor(private readonly rules: CustomRulesService) {}

  /** The project's custom rules. */
  @Get('projects/:projectId/automations/custom')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.rules.list(projectId, user.id);
  }

  /**
   * Create a rule (Admin). Triggers: task.created, task.status_changed (optional toStatusId), task.assigned, task.overdue,
   * issue.created, pull_request.merged. Conditions: task.priority, task.assigneeId, task.phaseId, task.sprintId,
   * task.statusCategory, issue.severity, issue.type with equals, not_equals, in, not_in, is_empty, is_not_empty.
   * Actions: notify, set_priority, move_status (not a closed status), add_comment.
   */
  @Post('projects/:projectId/automations/custom')
  @ApiBody({ schema: { type: 'object', example: RULE_EXAMPLE } })
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown) {
    return this.rules.create(projectId, user.id, body);
  }

  /** Check a rule without saving it. */
  @Post('automations/validate')
  @HttpCode(200)
  validate(@CurrentUser() user: AuthUser, @Body() dto: ValidateRuleDto) {
    return this.rules.check(dto.projectId, user.id, dto.rule);
  }

  @Get('automations/:ruleId')
  get(@CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.rules.get(ruleId, user.id);
  }

  /** Replace the definition, or just switch it: { "enabled": false }. */
  @Patch('automations/:ruleId')
  @ApiBody({ schema: { type: 'object', example: { enabled: false } } })
  update(@CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Body() body: unknown) {
    return this.rules.update(ruleId, user.id, body);
  }

  @Delete('automations/:ruleId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('ruleId', ParseUUIDPipe) ruleId: string) {
    return this.rules.remove(ruleId, user.id);
  }
}
