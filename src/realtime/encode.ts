/*
 * Wire encoding of the socket protocol (backend `socket/server.js`) and the HTML escaping the
 * driver applies to escaped console output (`he.encode` with default options).
 *
 * `htmlEncode` is derived from he 1.2.0, Copyright Mathias Bynens <https://mathiasbynens.be/>,
 * used under the MIT license (see THIRD_PARTY_NOTICES.md).
 */

import { promisify } from 'node:util';
import { deflate } from 'node:zlib';

const deflateAsync = promisify(deflate);

const UNSAFE_SYMBOLS = /["&'<>`]/g;
const ASTRAL_SYMBOLS = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
/**
 * Every code unit `he` escapes after the above (`regexBmpWhitelist`, which lists
 * `\x01-\t\x0B\f\x0E-\x1F\x7F\x81\x8D\x8F\x90\x9D\xA0-\uFFFF`), written as its complement.
 */
const NON_PRINTABLE_BMP = /[^\0\n\r -~\x80\x82-\x8C\x8E\x91-\x9C\x9E\x9F]/g;

/** Hexadecimal character reference of a symbol (a surrogate pair or a single code unit). */
function hexEscape(symbol: string): string {
  return `&#x${(symbol.codePointAt(0) ?? 0).toString(16).toUpperCase()};`;
}

/** `he.encode(text)` with default options, as the driver sends escaped `console.log` output. */
export function htmlEncode(text: string): string {
  return text
    .replace(UNSAFE_SYMBOLS, hexEscape)
    .replace(ASTRAL_SYMBOLS, hexEscape)
    .replace(NON_PRINTABLE_BMP, hexEscape);
}

/** A channel event as the official client parses it: `JSON.parse(data)` yielding `[channel, data]`. */
export function eventMessage(channel: string, data: unknown): string {
  return JSON.stringify([channel, data]);
}

/**
 * With `gzip on` the backend deflates (zlib format, level 1) and sends `gz:` plus base64 whenever
 * that is shorter than the plain message. The client inflates with `pako.ungzip(atob(...))`.
 */
export async function encodeFrame(message: string, gzip: boolean): Promise<string> {
  if (!gzip) return message;
  const compressed = `gz:${(await deflateAsync(message, { level: 1 })).toString('base64')}`;
  return compressed.length < message.length ? compressed : message;
}
