import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators';
import { validateArray } from '../common/validation';
import { AddDependencyDto, ByKeyQuery, CreateTaskDto, MyTasksQuery, RequiredSkillDto, TaskListQuery, UpdateTaskDto } from './dto/task.dto';
import { TasksService } from './tasks.service';

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** List tasks. Filters: status, assigneeId, phaseId, sprintId, parentTaskId, priority, overdue, q, cf[fieldId]; sort; limit and cursor. */
  @Get('projects/:projectId/tasks')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: TaskListQuery) {
    return this.tasks.list(projectId, user.id, q);
  }

  @Post('projects/:projectId/tasks')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateTaskDto) {
    return this.tasks.create(projectId, user.id, dto);
  }

  /** My unfinished tasks across all my projects, by due date. */
  @Get('me/tasks')
  mine(@CurrentUser() user: AuthUser, @Query() q: MyTasksQuery) {
    return this.tasks.myTasks(user.id, q);
  }

  /** Find a task by its short ID, for example MBA-42. */
  @Get('tasks/by-key/:shortId')
  byKey(@CurrentUser() user: AuthUser, @Param('shortId') key: string, @Query() q: ByKeyQuery) {
    return this.tasks.byKey(key, user.id, q.workspaceId);
  }

  /** Task details, with overdue, blocked, shortId and what the caller may do (permissions). */
  @Get('tasks/:taskId')
  get(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tasks.get(taskId, user.id);
  }

  @Patch('tasks/:taskId')
  update(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(taskId, user.id, dto);
  }

  /** Deletes the task and its subtasks. */
  @Delete('tasks/:taskId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tasks.remove(taskId, user.id);
  }

  /** Replace the required skills: [{ "skillId": "...", "minLevel": "intermediate" }]. */
  @Put('tasks/:taskId/skills')
  @ApiBody({ type: RequiredSkillDto, isArray: true })
  async setSkills(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: unknown) {
    return this.tasks.setSkills(taskId, user.id, await validateArray(body, RequiredSkillDto, 20));
  }

  /** Add a task this one must wait for; refused with DEPENDENCY_LOOP if it would make a loop. */
  @Post('tasks/:taskId/dependencies')
  addDependency(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: AddDependencyDto) {
    return this.tasks.addDependency(taskId, user.id, dto);
  }

  @Delete('tasks/:taskId/dependencies/:otherTaskId')
  @HttpCode(204)
  removeDependency(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Param('otherTaskId', ParseUUIDPipe) otherTaskId: string) {
    return this.tasks.removeDependency(taskId, user.id, otherTaskId);
  }
}
