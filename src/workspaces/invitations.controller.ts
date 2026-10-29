import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Public } from '../common/decorators';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /** Lets the sign-up page show "You are invited to Acme Software" before the person registers. */
  @Public()
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  /** For people who already have an account. New people send the token to POST /auth/register instead. */
  @Post(':token/accept')
  accept(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.invitations.accept(token, user.id);
  }

  @Delete(':invitationId')
  @HttpCode(204)
  cancel(@CurrentUser() user: AuthUser, @Param('invitationId', ParseUUIDPipe) invitationId: string) {
    return this.invitations.cancel(invitationId, user.id);
  }
}

