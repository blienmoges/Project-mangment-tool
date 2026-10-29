import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ManualEntryDto, StartTimerDto, TimeReportQuery, UpdateEntryDto } from './dto/time.dto';
import { TimeService } from './time.service';

@Controller()
export class TimeController {
  constructor(private readonly time: TimeService) {}

  /** Start a timer on the task (assignee, PM); refused while your timer runs elsewhere. */
  @Post('tasks/:taskId/timer/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: StartTimerDto) {
    return this.time.start(taskId, user.id, dto.note);
  }

  /** Stop your running timer and save the minutes. */
  @Post('timer/stop')
  @HttpCode(200)
  stop(@CurrentUser() user: AuthUser) {
    return this.time.stop(user.id);
  }

  /** Your running timer, if any. */
  @Get('timer')
  timer(@CurrentUser() user: AuthUser) {
    return this.time.timer(user.id);
  }

  /** Entries plus estimate versus logged. */
  @Get('tasks/:taskId/time-entries')
  list(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.time.list(taskId, user.id);
  }

  /** Add time by hand: { "minutes": 90, "date": "2027-02-10", "note": "..." }. */
  @Post('tasks/:taskId/time-entries')
  add(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ManualEntryDto) {
    return this.time.addManual(taskId, user.id, dto);
  }

  @Patch('time-entries/:entryId')
  update(@CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) entryId: string, @Body() dto: UpdateEntryDto) {
    return this.time.update(entryId, user.id, dto);
  }

  @Delete('time-entries/:entryId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('entryId', ParseUUIDPipe) entryId: string) {
    return this.time.remove(entryId, user.id);
  }

  /** Hours per person, task and sprint (PM, Admin); ?from=&to=; ?format=csv downloads a CSV file. */
  @Get('projects/:projectId/time-report')
  async report(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: TimeReportQuery, @Res({ passthrough: true }) res: Response) {
    const result = await this.time.report(projectId, user.id, q);
    if ('csv' in result) {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.fileName}"` });
      return result.csv;
    }
    return result;
  }
}
