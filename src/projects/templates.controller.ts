import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { TemplatesService } from './templates.service';

export class SaveTemplateDto {
  @IsString() @Length(2, 120)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
}

@Controller()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /** Save this project's phases and tasks as a template (PM, Admin). */
  @Post('projects/:projectId/template')
  save(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: SaveTemplateDto) {
    return this.templates.saveFromProject(projectId, user.id, dto.name, dto.description);
  }

  /** Templates of the workspace; create a project from one with POST /spaces/:id/projects and "templateId". */
  @Get('workspaces/:workspaceId/templates')
  list(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.templates.list(workspaceId, user.id);
  }

  @Get('templates/:templateId')
  get(@CurrentUser() user: AuthUser, @Param('templateId', ParseUUIDPipe) templateId: string) {
    return this.templates.get(templateId, user.id);
  }

  @Delete('templates/:templateId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('templateId', ParseUUIDPipe) templateId: string) {
    return this.templates.remove(templateId, user.id);
  }
}
