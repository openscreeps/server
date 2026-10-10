import { Controller, Inject, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ApiRequest } from '../contracts.ts';
import { MessagesService } from '../services/messages.ts';
import { ApiOperation } from './operations.ts';
import { ApiGuard, ApiInput, ApiInterceptor } from './transport.ts';

@Controller()
@UseGuards(ApiGuard)
@UseInterceptors(ApiInterceptor)
export class MessagesController {
  constructor(@Inject(MessagesService) readonly service: MessagesService) {}

  @ApiOperation('userMessagesSend', { auth: true, write: true })
  send(@ApiInput() request: ApiRequest) {
    return this.service.send(request);
  }

  @ApiOperation('userMessagesList', { auth: true })
  list(@ApiInput() request: ApiRequest) {
    return this.service.list(request);
  }

  @ApiOperation('userMessagesIndex', { auth: true })
  index(@ApiInput() request: ApiRequest) {
    return this.service.index(request);
  }

  @ApiOperation('userMessagesMarkRead', { auth: true, write: true })
  markRead(@ApiInput() request: ApiRequest) {
    return this.service.markRead(request);
  }

  @ApiOperation('userMessagesUnreadCount', { auth: true })
  unreadCount(@ApiInput() request: ApiRequest) {
    return this.service.unreadCount(request);
  }
}
