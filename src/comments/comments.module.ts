import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({ imports: [ProjectsModule], controllers: [CommentsController], providers: [CommentsService] })
export class CommentsModule {}
