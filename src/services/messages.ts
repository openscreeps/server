/*
 * Player-to-player messages (port of backend `api/user-messages.js`).
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { Inject, Injectable } from '@nestjs/common';
import { newId, ownValue } from '@openscreeps/game';
import {
  ApiError,
  requireUser,
  type ApiContext,
  type ApiRequest,
  type ServerContext,
  type UserMessage,
} from '../contracts.ts';
import { publicUsers } from '../api/gameplay-support.ts';
import { SERVER_CONTEXT } from '../api/transport.ts';

const MAX_TEXT_LENGTH = 100 * 1024;
const LIST_LIMIT = 100;
/** Backend `USER_ONLINE` window: online players are not mailed unless `sendOnline` is set. */
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

/** Newest first; ids break ties of messages sent within one millisecond. */
function newestFirst(a: UserMessage, b: UserMessage): number {
  return b.date - a.date || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0);
}

/** Backend `sendMessageNotification`: upserts a `msg` notification honoring `notifyPrefs`. */
function notifyRecipient(context: ServerContext, userId: string, senderName: string): void {
  const profile = context.state.profiles[userId];
  const prefs = profile?.notifyPrefs;
  const now = context.now();
  if (prefs?.disabledOnMessages === true) return;
  if (prefs?.sendOnline !== true && (profile?.lastOnline ?? 0) > now - ONLINE_WINDOW_MS) return;
  const message = `<a href="https://screeps.com/a/#!/messages">New message</a> from user ${senderName}`;
  const { notifications } = context.state.world;
  const existing = Object.values(notifications).find(
    (doc) =>
      doc.user === userId && doc.type === 'msg' && doc.message === message && doc.date <= now,
  );
  if (existing) {
    existing.date = now;
    existing.count += 1;
    return;
  }
  const id = newId(context.state);
  notifications[id] = { _id: id, user: userId, message, date: now, type: 'msg', count: 1 };
}

@Injectable()
export class MessagesService {
  constructor(@Inject(SERVER_CONTEXT) readonly context: ApiContext) {}

  send(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { text, respondent } = request.body;
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) {
      throw new ApiError('text too long');
    }
    if (typeof respondent !== 'string' || !ownValue(this.context.state.world.users, respondent)) {
      throw new ApiError('invalid respondent');
    }
    const { state } = this.context;
    const date = this.context.now();
    const outMessage: UserMessage = {
      _id: newId(state),
      user: user._id,
      respondent,
      date,
      type: 'out',
      text,
      unread: true,
    };
    const inMessage: UserMessage = {
      _id: newId(state),
      user: respondent,
      respondent: user._id,
      date,
      type: 'in',
      text,
      unread: true,
      outMessage: outMessage._id,
    };
    state.messages[outMessage._id] = outMessage;
    state.messages[inMessage._id] = inMessage;
    notifyRecipient(this.context, respondent, user.username ?? user._id);
    this.context.publish(`user:${user._id}/message:${respondent}`, { message: outMessage });
    this.context.publish(`user:${respondent}/message:${user._id}`, { message: inMessage });
    this.context.publish(`user:${respondent}/newMessage`, { message: inMessage });
    return {};
  }

  list(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const respondent = request.query.get('respondent');
    const messages = Object.values(this.context.state.messages)
      .filter((message) => message.user === user._id && message.respondent === respondent)
      .sort(newestFirst)
      .slice(0, LIST_LIMIT)
      .reverse();
    return { messages };
  }

  index(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const latest = new Map<string, UserMessage>();
    for (const message of Object.values(this.context.state.messages)
      .filter((message) => message.user === user._id)
      .sort(newestFirst)) {
      if (!latest.has(message.respondent)) latest.set(message.respondent, message);
    }
    const messages = [...latest].map(([_id, message]) => ({ _id, message }));
    return { messages, users: publicUsers(this.context.state.world, latest.keys()) };
  }

  markRead(request: ApiRequest) {
    const user = requireUser(request, this.context);
    const { id } = request.body;
    const message = ownValue(this.context.state.messages, id);
    if (!message || message.user !== user._id || message.type !== 'in') {
      throw new ApiError('invalid id');
    }
    message.unread = false;
    const outMessage =
      message.outMessage === undefined
        ? undefined
        : this.context.state.messages[message.outMessage];
    if (outMessage) outMessage.unread = false;
    this.context.publish(`user:${message.user}/message:${message.respondent}`, {
      message: { _id: message._id, unread: false },
    });
    this.context.publish(`user:${message.respondent}/message:${message.user}`, {
      message: { _id: message.outMessage, unread: false },
    });
    return {};
  }

  unreadCount(request: ApiRequest) {
    const user = requireUser(request, this.context);
    let count = 0;
    for (const message of Object.values(this.context.state.messages)) {
      if (message.user === user._id && message.type === 'in' && message.unread) count++;
    }
    return { count };
  }
}
