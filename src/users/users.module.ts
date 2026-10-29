import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { AvatarsController } from './avatars.controller';
import { MeController } from './me.controller';
import { UsersService } from './users.service';

@Module({ imports: [FilesModule], controllers: [MeController, AvatarsController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}

