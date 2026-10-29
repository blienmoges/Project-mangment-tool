import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CreateStatusDto, DeleteStatusQuery, UpdateStatusDto } from './dto/space.dto';
import { StatusesService } from './statuses.service';

@Controller()
export class StatusesController {
  constructor(private readonly statuses: StatusesService) {}

  /** The space's task workflow in board order. */
  @Get('spaces/:spaceId/statuses')
  list(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string) {
    return this.statuses.list(spaceId, user.id);
  }

  @Post('spaces/:spaceId/statuses')
  create(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Body() dto: CreateStatusDto) {
    return this.statuses.create(spaceId, user.id, dto);
  }

  @Patch('statuses/:statusId')
  update(@CurrentUser() user: AuthUser, @Param('statusId', ParseUUIDPipe) statusId: string, @Body() dto: UpdateStatusDto) {
    return this.statuses.update(statusId, user.id, dto);
  }

  /** Remove a status; if tasks use it, send ?moveTasksTo=<statusId> of the same category. */
  @Delete('statuses/:statusId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('statusId', ParseUUIDPipe) statusId: string, @Query() q: DeleteStatusQuery) {
    return this.statuses.remove(statusId, user.id, q.moveTasksTo);
  }
}
