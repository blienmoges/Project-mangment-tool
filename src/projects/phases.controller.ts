import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CreatePhaseDto, DeletePhaseQuery, UpdatePhaseDto } from './dto/project.dto';
import { PhasesService } from './phases.service';

@Controller()
export class PhasesController {
  constructor(private readonly phases: PhasesService) {}

  /** Phases in order, with progress. */
  @Get('projects/:projectId/phases')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.phases.list(projectId, user.id);
  }

  @Post('projects/:projectId/phases')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreatePhaseDto) {
    return this.phases.create(projectId, user.id, dto);
  }

  /** Rename, change the due date (null clears it) or reorder (position). */
  @Patch('phases/:phaseId')
  update(@CurrentUser() user: AuthUser, @Param('phaseId', ParseUUIDPipe) phaseId: string, @Body() dto: UpdatePhaseDto) {
    return this.phases.update(phaseId, user.id, dto);
  }

  /** Remove a phase; ?moveTasksTo=<phaseId> moves its tasks, otherwise they are left without a phase. */
  @Delete('phases/:phaseId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('phaseId', ParseUUIDPipe) phaseId: string, @Query() q: DeletePhaseQuery) {
    return this.phases.remove(phaseId, user.id, q.moveTasksTo);
  }
}
