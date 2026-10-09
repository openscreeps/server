/*
 * SockJS endpoint `/socket` of the official client (backend `game/socket/server.js`): websocket
 * plus every SockJS fallback transport, served by the `sockjs` package like upstream.
 */

import type { IncomingMessage, Server } from 'node:http';
import sockjs, { type Connection, type ServerOptions } from 'sockjs';
import type { ApiContext } from '../contracts.ts';
import { RealtimeHub } from './hub.ts';

export { historyTicks, type ObjectsDiff } from './diff.ts';
export { PROTOCOL } from './hub.ts';

const PREFIX = '/socket';
/** Largest client frame or POST body accepted; protocol commands are short text lines. */
const MAX_CLIENT_FRAME = 1024 * 1024;

/**
 * SockJS buffers whole `xhr_send`/`jsonp_send` bodies without a limit (before it even looks up
 * the session), so the fallback transports get the websocket frame limit: a larger body drops
 * the connection. Install after SockJS so this listener runs first.
 */
function limitPostBodies(server: Server): void {
  server.prependListener('request', (request: IncomingMessage) => {
    if (request.method !== 'POST' || !request.url?.startsWith(`${PREFIX}/`)) return;
    if (Number(request.headers['content-length']) > MAX_CLIENT_FRAME) {
      request.destroy();
      return;
    }
    let received = 0;
    request.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_CLIENT_FRAME) request.destroy();
    });
  });
}

/**
 * Install the socket server on an HTTP server. Call after the HTTP framework attached its
 * `request` listener: SockJS takes over `/socket/*` and passes every other request on.
 */
export function installRealtime(server: Server, context: ApiContext): { close(): void } {
  const hub = new RealtimeHub(context);
  const options: ServerOptions & { faye_server_options: { maxLength: number } } = {
    prefix: PREFIX,
    faye_server_options: { maxLength: MAX_CLIENT_FRAME },
    log(severity, message) {
      if (severity === 'error' && context.events.listenerCount('error') > 0) {
        context.events.emit('error', new Error(`SockJS: ${message}`));
      }
    },
  };
  const socketServer = sockjs.createServer(options);
  socketServer.on('connection', (connection: Connection | null) => {
    if (!connection) return;
    const session = hub.connect({
      write: (message) => connection.write(message),
      close: () => connection.close(),
    });
    if (!session) {
      connection.close();
      return;
    }
    connection.on('data', (message) => {
      session.receive(message);
    });
    connection.on('close', () => {
      session.disconnect();
    });
  });
  socketServer.installHandlers(server);
  limitPostBodies(server);
  return {
    close() {
      hub.close();
    },
  };
}
