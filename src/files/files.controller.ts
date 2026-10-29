import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthUser, CurrentUser, Public } from '../common/decorators';
import { AttachmentsService, MAX_FILE_BYTES } from './attachments.service';

const upload = FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const fileBody = { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } };

@Controller()
export class FilesController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** Upload a file to a task (multipart field "file", up to 20 MB). */
  @Post('tasks/:taskId/attachments')
  @UseInterceptors(upload)
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  toTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @UploadedFile() file: Express.Multer.File) {
    return this.attachments.uploadToTask(taskId, user.id, file);
  }

  @Get('tasks/:taskId/attachments')
  listTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.attachments.listForTask(taskId, user.id);
  }

  /** Add a screenshot or log file to an issue (multipart field "file", up to 20 MB). */
  @Post('issues/:issueId/attachments')
  @UseInterceptors(upload)
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  toIssue(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string, @UploadedFile() file: Express.Multer.File) {
    return this.attachments.uploadToIssue(issueId, user.id, file);
  }

  @Get('issues/:issueId/attachments')
  listIssue(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string) {
    return this.attachments.listForIssue(issueId, user.id);
  }

  /** A download link valid for 5 minutes, for anyone who can see the task, issue or message. */
  @Get('attachments/:attachmentId')
  link(@CurrentUser() user: AuthUser, @Param('attachmentId', ParseUUIDPipe) id: string) {
    return this.attachments.link(id, user.id);
  }

  @Delete('attachments/:attachmentId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('attachmentId', ParseUUIDPipe) id: string) {
    return this.attachments.remove(id, user.id);
  }

  /** The file itself, through a link from GET /attachments/:id (no login needed; the link expires). */
  @Public()
  @Get('files/:token')
  download(@Param('token') token: string, @Res() res: Response) {
    return this.attachments.download(token, res);
  }
}
