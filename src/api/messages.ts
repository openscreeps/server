import { Controller, Get, Inject, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { MessagesService } from '../services/messages.ts';
import { ApiGuard, ApiInput, ApiInterceptor, ApiPolicy } from './transport.ts';

@Controller('api/user/messages')
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class MessagesController {
  constructor(@Inject(MessagesService) readonly service: MessagesService) {}

  @Post('send')
  @ApiPolicy({ auth: true, write: true })
  send(@ApiInput() request: ApiRequest) {
    return this.service.send(request);
  }

  @Get('list')
  @ApiPolicy({ auth: true })
  list(@ApiInput() request: ApiRequest) {
    return this.service.list(request);
  }

  @Get('index')
  @ApiPolicy({ auth: true })
  index(@ApiInput() request: ApiRequest) {
    return this.service.index(request);
  }

  @Post('mark-read')
  @ApiPolicy({ auth: true, write: true })
  markRead(@ApiInput() request: ApiRequest) {
    return this.service.markRead(request);
  }

  @Get('unread-count')
  @ApiPolicy({ auth: true })
  unreadCount(@ApiInput() request: ApiRequest) {
    return this.service.unreadCount(request);
  }
}
