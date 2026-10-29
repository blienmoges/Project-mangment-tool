import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CommentsService } from './comments.service';

export class CommentDto {
  /** Up to 10 000 characters; mention people as @[Name](userId). */
  @IsString()
  @Length(1, 10000)
  body: string;
}

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /** The task's comment thread, oldest first. */
  @Get('tasks/:taskId/comments')
  list(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.comments.list(taskId, user.id);
  }

  @Post('tasks/:taskId/comments')
  create(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: CommentDto) {
    return this.comments.create(taskId, user.id, dto.body);
  }

  @Patch('comments/:commentId')
  edit(@CurrentUser() user: AuthUser, @Param('commentId', ParseUUIDPipe) commentId: string, @Body() dto: CommentDto) {
    return this.comments.edit(commentId, user.id, dto.body);
  }

  @Delete('comments/:commentId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('commentId', ParseUUIDPipe) commentId: string) {
    return this.comments.remove(commentId, user.id);
  }
}
