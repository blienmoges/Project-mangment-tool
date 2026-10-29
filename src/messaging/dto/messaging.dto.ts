import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

export class OpenDirectDto {
  /** The other person (same workspace, not a Guest). */
  @IsUUID()
  userId: string;

  /** Needed only when you share several workspaces with them. */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class ChannelListQuery {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class MessageListQuery {
  /** A message id: returns the messages sent before it (for loading older ones). */
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SendMessageDto {
  /** Text, up to 5000 characters; mention people as @[Name](userId). Optional when files are attached. */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;
}

export class EditMessageDto {
  @IsString()
  @Length(1, 5000)
  body: string;
}

export class SearchQuery {
  /** Words to find (all of them must appear). */
  @IsString()
  @Length(1, 100)
  q: string;

  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}
