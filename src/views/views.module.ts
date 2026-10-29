import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ViewsController } from './views.controller';
import { ViewsService } from './views.service';

@Module({ imports: [ProjectsModule], controllers: [ViewsController], providers: [ViewsService] })
export class ViewsModule {}
