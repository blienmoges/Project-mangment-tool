import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

@Module({ imports: [ProjectsModule], controllers: [IssuesController], providers: [IssuesService] })
export class IssuesModule {}
