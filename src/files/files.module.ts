import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AttachmentsService } from './attachments.service';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [ProjectsModule],
  controllers: [FilesController],
  providers: [AttachmentsService, StorageService],
  exports: [AttachmentsService, StorageService],
})
export class FilesModule {}
