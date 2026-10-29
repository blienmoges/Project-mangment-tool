import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { NotificationEvent } from '@prisma/client';
import { PageQuery } from '../../common/paging';
import { toBoolean } from '../../common/query';

export class NotificationListQuery extends PageQuery {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;

  /** Only this workspace's notifications. */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class WorkspaceScopeQuery {
  /** Required when you belong to more than one workspace. */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class PreferenceDto {
  @ApiProperty({ enum: NotificationEvent })
  @IsEnum(NotificationEvent)
  eventType: NotificationEvent;

  @IsBoolean()
  email: boolean;

  /** Needs a phone number on your profile. */
  @IsBoolean()
  sms: boolean;

  /** Needs a browser that allowed notifications (POST /me/push-subscriptions). */
  @IsBoolean()
  push: boolean;
}
