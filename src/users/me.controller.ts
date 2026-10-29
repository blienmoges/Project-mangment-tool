import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { MAX_AVATAR_BYTES } from './avatar';
import { AuthUser, CurrentUser } from '../common/decorators';
import { SetSkillDto, UpdateMeDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user.id, dto);
  }

  /** Upload a profile photo (multipart field "file"; PNG, JPEG or WebP, up to 2 MB). */
  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  avatar(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    return this.users.setAvatar(user.id, file);
  }

  @Delete('avatar')
  @HttpCode(204)
  deleteAvatar(@CurrentUser() user: AuthUser) {
    return this.users.deleteAvatar(user.id);
  }

  @Get('skills')
  skills(@CurrentUser() user: AuthUser) {
    return this.users.mySkills(user.id);
  }

  @Put('skills/:skillId')
  setSkill(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string, @Body() dto: SetSkillDto) {
    return this.users.setSkill(user.id, skillId, dto);
  }

  @Delete('skills/:skillId')
  @HttpCode(204)
  removeSkill(@CurrentUser() user: AuthUser, @Param('skillId', ParseUUIDPipe) skillId: string) {
    return this.users.removeSkill(user.id, skillId);
  }
}

