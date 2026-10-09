/*
 * Player-to-player messages (port of backend `api/user-messages.js`).
 *
 * Portions derived from screeps/backend-local, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import {
  ApiError,
  newId,
  requireUser,
  type ApiRoute,
  type ServerContext,
  type UserMessage,
} from '../contracts.ts';
import { ownValue } from './gameplay-support.ts';

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

export const messageRoutes: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/user/messages/send',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { text, respondent } = request.body;
      if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) {
        throw new ApiError('text too long');
      }
      if (typeof respondent !== 'string' || !ownValue(context.state.world.users, respondent)) {
        throw new ApiError('invalid respondent');
      }
      const { state } = context;
      const date = context.now();
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
      notifyRecipient(context, respondent, user.username ?? user._id);
      context.publish(`user:${user._id}/message:${respondent}`, { message: outMessage });
      context.publish(`user:${respondent}/message:${user._id}`, { message: inMessage });
      context.publish(`user:${respondent}/newMessage`, { message: inMessage });
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/messages/list',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const respondent = request.query.get('respondent');
      const messages = Object.values(context.state.messages)
        .filter((message) => message.user === user._id && message.respondent === respondent)
        .sort(newestFirst)
        .slice(0, LIST_LIMIT)
        .reverse();
      return { messages };
    },
  },
  {
    method: 'GET',
    path: '/api/user/messages/index',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const latest = new Map<string, UserMessage>();
      for (const message of Object.values(context.state.messages)
        .filter((message) => message.user === user._id)
        .sort(newestFirst)) {
        if (!latest.has(message.respondent)) latest.set(message.respondent, message);
      }
      const messages = [...latest].map(([_id, message]) => ({ _id, message }));
      const users: Record<string, { _id: string; username?: string; badge?: unknown }> = {};
      for (const id of latest.keys()) {
        const respondent = context.state.world.users[id];
        if (!respondent) continue;
        const info: { _id: string; username?: string; badge?: unknown } = { _id: id };
        if (respondent.username !== undefined) info.username = respondent.username;
        if (respondent.badge !== undefined) info.badge = respondent.badge;
        users[id] = info;
      }
      return { messages, users };
    },
  },
  {
    method: 'POST',
    path: '/api/user/messages/mark-read',
    auth: true,
    write: true,
    handle(request, context) {
      const user = requireUser(request, context);
      const { id } = request.body;
      const message = ownValue(context.state.messages, id);
      if (!message || message.user !== user._id || message.type !== 'in') {
        throw new ApiError('invalid id');
      }
      message.unread = false;
      const outMessage =
        message.outMessage === undefined ? undefined : context.state.messages[message.outMessage];
      if (outMessage) outMessage.unread = false;
      context.publish(`user:${message.user}/message:${message.respondent}`, {
        message: { _id: message._id, unread: false },
      });
      context.publish(`user:${message.respondent}/message:${message.user}`, {
        message: { _id: message.outMessage, unread: false },
      });
      return {};
    },
  },
  {
    method: 'GET',
    path: '/api/user/messages/unread-count',
    auth: true,
    handle(request, context) {
      const user = requireUser(request, context);
      let count = 0;
      for (const message of Object.values(context.state.messages)) {
        if (message.user === user._id && message.type === 'in' && message.unread) count++;
      }
      return { count };
    },
  },
];
