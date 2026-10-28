import { Body, Controller, Delete, Get, HttpCode, Param, ParseArrayPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { Errors } from '../common/app-exception';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AddDependencyDto, ByKeyQuery, CreateTaskDto, MyTasksQuery, RequiredSkillDto, TaskListQuery, UpdateTaskDto } from './dto/task.dto';
import { TasksService } from './tasks.service';

const skillsArray = new ParseArrayPipe({
  items: RequiredSkillDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  // Item errors arrive as class-validator errors, a broken body as a sentence; both become the usual `fields`.
  exceptionFactory: (error: unknown) =>
    Array.isArray(error)
      ? Errors.validation(Object.fromEntries((error as ValidationError[]).map((e) => [`requiredSkills.${e.property}`, Object.values(e.constraints ?? {})[0] ?? 'is invalid'])))
      : Errors.validation({ requiredSkills: String(error) }),
});

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** List tasks. Filters: status, assigneeId (or me/none), phaseId, sprintId (or backlog), overdue, priority, q, fieldId+fieldValue. */
  @Get('projects/:projectId/tasks')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: TaskListQuery) {
    return this.tasks.list(projectId, user.id, q);
  }

  @Post('projects/:projectId/tasks')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateTaskDto) {
    return this.tasks.create(projectId, user.id, dto);
  }

  /** Find a task by its short ID, for example MBA-42. */
  @Get('tasks/by-key/:shortId')
  byKey(@CurrentUser() user: AuthUser, @Param('shortId') key: string, @Query() q: ByKeyQuery) {
    return this.tasks.byKey(key, user.id, q.workspaceId);
  }

  /** Task details with calculated overdue, blocked and shortId, and what the caller may do with it. */
  @Get('tasks/:taskId')
  get(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tasks.get(taskId, user.id);
  }

  @Patch('tasks/:taskId')
  update(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(taskId, user.id, dto);
  }

  /** Delete a task and its subtasks. */
  @Delete('tasks/:taskId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tasks.remove(taskId, user.id);
  }

  /** Replace the required skills: [{ "skillId": "...", "minLevel": "intermediate" }]. */
  @Put('tasks/:taskId/skills')
  @ApiBody({ type: RequiredSkillDto, isArray: true })
  setSkills(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body(skillsArray) skills: RequiredSkillDto[]) {
    if (skills.length > 20) throw Errors.validation({ requiredSkills: 'at most 20 skills' });
    return this.tasks.setSkills(taskId, user.id, skills);
  }

  /** Add a task this one must wait for; refused with 409 DEPENDENCY_LOOP if it would make a loop. */
  @Post('tasks/:taskId/dependencies')
  addDependency(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: AddDependencyDto) {
    return this.tasks.addDependency(taskId, user.id, dto);
  }

  @Delete('tasks/:taskId/dependencies/:otherTaskId')
  @HttpCode(204)
  removeDependency(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Param('otherTaskId', ParseUUIDPipe) otherTaskId: string) {
    return this.tasks.removeDependency(taskId, user.id, otherTaskId);
  }

  /** My open tasks across all projects, soonest due first. */
  @Get('me/tasks')
  myTasks(@CurrentUser() user: AuthUser, @Query() q: MyTasksQuery) {
    return this.tasks.myTasks(user.id, q.workspaceId);
  }
}
