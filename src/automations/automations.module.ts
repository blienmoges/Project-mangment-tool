import { Global, Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { CustomRulesController } from './custom-rules.controller';
import { CustomRulesService } from './custom-rules.service';

@Global()
@Module({
  imports: [ProjectsModule],
  controllers: [AutomationsController, CustomRulesController],
  providers: [AutomationsService, CustomRulesService],
  exports: [AutomationsService, CustomRulesService],
})
export class AutomationsModule {}
