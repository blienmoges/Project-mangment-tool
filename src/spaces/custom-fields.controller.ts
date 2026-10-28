import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CustomFieldsService } from './custom-fields.service';
import { CreateCustomFieldDto, UpdateCustomFieldDto } from './dto/space.dto';

@Controller()
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get('spaces/:spaceId/custom-fields')
  list(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string) {
    return this.fields.list(spaceId, user.id);
  }

  @Post('spaces/:spaceId/custom-fields')
  create(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Body() dto: CreateCustomFieldDto) {
    return this.fields.create(spaceId, user.id, dto);
  }

  @Patch('custom-fields/:fieldId')
  update(@CurrentUser() user: AuthUser, @Param('fieldId', ParseUUIDPipe) fieldId: string, @Body() dto: UpdateCustomFieldDto) {
    return this.fields.update(fieldId, user.id, dto);
  }

  @Delete('custom-fields/:fieldId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('fieldId', ParseUUIDPipe) fieldId: string) {
    return this.fields.remove(fieldId, user.id);
  }
}
