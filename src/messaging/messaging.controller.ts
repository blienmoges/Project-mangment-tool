import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators';
import { MAX_FILE_BYTES } from '../files/attachments.service';
import { ChannelListQuery, EditMessageDto, MessageListQuery, OpenDirectDto, SearchQuery, SendMessageDto } from './dto/messaging.dto';
import { MessagingService } from './messaging.service';

@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  /** The caller's channels (direct, project, team) with unread counts, most recent first. */
  @Get('channels')
  list(@CurrentUser() user: AuthUser, @Query() q: ChannelListQuery) {
    return this.messaging.list(user.id, q.workspaceId);
  }

  /** Open or create a direct conversation: { "userId": "..." }. */
  @Post('channels/direct')
  @HttpCode(200)
  direct(@CurrentUser() user: AuthUser, @Body() dto: OpenDirectDto) {
    return this.messaging.openDirect(user.id, dto);
  }

  /** Messages, newest first; ?before=<messageId> loads older ones. */
  @Get('channels/:channelId/messages')
  messages(@CurrentUser() user: AuthUser, @Param('channelId', ParseUUIDPipe) channelId: string, @Query() q: MessageListQuery) {
    return this.messaging.messages(channelId, user.id, q);
  }

  /**
   * Send a message. JSON { "body": "..." }, or multipart/form-data with "body" and up to 5 "files" (20 MB each).
   * Mention people as @[Name](userId); they are notified.
   */
  @Post('channels/:channelId/messages')
  @UseInterceptors(FilesInterceptor('files', 5, { limits: { fileSize: MAX_FILE_BYTES, files: 5 } }))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { body: { type: 'string' }, files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  send(@CurrentUser() user: AuthUser, @Param('channelId', ParseUUIDPipe) channelId: string, @Body() dto: SendMessageDto, @UploadedFiles() files: Express.Multer.File[] = []) {
    return this.messaging.send(channelId, user.id, dto.body, files);
  }

  /** Mark everything up to now as read. */
  @Post('channels/:channelId/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return this.messaging.markRead(channelId, user.id);
  }

  /** Search your conversations: ?q=login (all words must appear), optional ?workspaceId=. */
  @Get('messages/search')
  search(@CurrentUser() user: AuthUser, @Query() q: SearchQuery) {
    return this.messaging.search(user.id, q);
  }

  @Patch('messages/:messageId')
  edit(@CurrentUser() user: AuthUser, @Param('messageId', ParseUUIDPipe) messageId: string, @Body() dto: EditMessageDto) {
    return this.messaging.edit(messageId, user.id, dto);
  }

  @Delete('messages/:messageId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('messageId', ParseUUIDPipe) messageId: string) {
    return this.messaging.remove(messageId, user.id);
  }
}
