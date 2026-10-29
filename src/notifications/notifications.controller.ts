import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsObject, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { ApiBody } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators';
import { validateArray } from '../common/validation';
import { NotificationListQuery, PreferenceDto, WorkspaceScopeQuery } from './dto/notification.dto';
import { InboxService } from './inbox.service';
import { PushService } from './push.service';

class PushKeysDto {
  @IsString() @MaxLength(200)
  p256dh: string;

  @IsString() @MaxLength(100)
  auth: string;
}

export class PushSubscriptionDto {
  /** From the browser's PushSubscription.toJSON(). */
  @IsUrl({ protocols: ['https'], require_protocol: true }) @MaxLength(1000)
  endpoint: string;

  @IsObject() @ValidateNested() @Type(() => PushKeysDto)
  keys: PushKeysDto;
}

export class PushEndpointDto {
  @IsString() @MaxLength(1000)
  endpoint: string;
}

@Controller()
export class NotificationsController {
  constructor(
    private readonly inbox: InboxService,
    private readonly push: PushService,
  ) {}

  /** The server's public VAPID key, for the browser's pushManager.subscribe(). */
  @Get('push/public-key')
  publicKey() {
    return { publicKey: this.push.publicKey ?? null };
  }

  /** Save this browser's push subscription. */
  @Post('me/push-subscriptions')
  @HttpCode(200)
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: PushSubscriptionDto, @Headers('user-agent') ua: string) {
    return this.push.subscribe(user.id, dto, ua);
  }

  /** Stop push notifications in this browser: { "endpoint": "..." }. */
  @Delete('me/push-subscriptions')
  @HttpCode(204)
  unsubscribe(@CurrentUser() user: AuthUser, @Body() dto: PushEndpointDto) {
    return this.push.unsubscribe(user.id, dto.endpoint);
  }

  /** The caller's notifications, newest first; ?unread=true, ?workspaceId=, limit and cursor. */
  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationListQuery) {
    return this.inbox.list(user.id, q);
  }

  /** The number for the badge: { count, byWorkspace }. */
  @Get('notifications/unread-count')
  unread(@CurrentUser() user: AuthUser) {
    return this.inbox.unreadCount(user.id);
  }

  /** Mark one as read; returns the new unread count. */
  @Post('notifications/:notificationId/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param('notificationId', ParseUUIDPipe) id: string) {
    return this.inbox.markRead(user.id, id);
  }

  /** Mark all as read (optionally one workspace's); returns the new unread count. */
  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser, @Query() q: WorkspaceScopeQuery) {
    return this.inbox.markAllRead(user.id, q.workspaceId);
  }

  /** Email, SMS and push setting for each event type in a workspace. */
  @Get('me/notification-preferences')
  preferences(@CurrentUser() user: AuthUser, @Query() q: WorkspaceScopeQuery) {
    return this.inbox.preferences(user.id, q.workspaceId);
  }

  /** Save settings: [{ "eventType": "overdue", "email": true, "sms": true, "push": false }]. */
  @Put('me/notification-preferences')
  @ApiBody({ type: PreferenceDto, isArray: true })
  async save(@CurrentUser() user: AuthUser, @Query() q: WorkspaceScopeQuery, @Body() body: unknown) {
    return this.inbox.savePreferences(user.id, await validateArray(body, PreferenceDto, 100), q.workspaceId);
  }
}
