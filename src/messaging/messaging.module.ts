import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({ imports: [FilesModule], controllers: [MessagingController], providers: [MessagingService] })
export class MessagingModule {}
