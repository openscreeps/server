/*
 * Binds Nest handlers to operations of the generated OpenScreeps contract (`api/openapi.json`,
 * composed by `scripts/generate-api.mjs`). Each decorator registers the route from the generated
 * operation manifest, so method and path cannot drift from the contract, and constrains the
 * decorated method's return type to that operation's generated success body.
 *
 * Request inputs remain untrusted: services validate `ApiRequest` themselves rather than trusting
 * generated request types that describe well-formed callers.
 */

import {
  applyDecorators,
  RequestMapping,
  RequestMethod,
  SetMetadata,
  type StreamableFile,
} from '@nestjs/common';
import { operations, type OperationId, type SuccessBody } from '../generated/api/index.ts';
import type { RawResponse } from '../contracts.ts';
import { ApiPolicy, type ApiPolicyOptions } from './transport.ts';

export type { OperationId };

/** Metadata key holding the operationId of a contract-bound handler. */
export const OPERATION_ID = Symbol('OperationId');

type Bytes = Uint8Array;
type NonJson = string | Bytes | undefined;

type Declared<T> = {
  [Key in keyof T as string extends Key ? never : number extends Key ? never : Key]: T[Key];
};
// JSON Schema's additionalProperties applies only to undeclared names. TypeScript index
// signatures also cover declared names, so their value type must admit those named fields.
type PropertyValue<T, Key extends keyof T> = string extends Key
  ? T[Key] | Declared<T>[keyof Declared<T>]
  : T[Key];

/**
 * A JSON value as the server may produce it: an optional property may also hold `undefined`,
 * which JSON serialization omits exactly like an absent property. Unconstrained additional
 * properties impose no return-value restriction: domain interfaces need no artificial index
 * signature. Typed dictionary entries and every declared property remain checked.
 */
type SerializableObject<T> = {
  [
    Key in keyof T as unknown extends T[Key]
      ? string extends Key
        ? never
        : number extends Key
          ? never
          : Key
      : Key
  ]: Record<string, never> extends Pick<T, Key>
    ? Serializable<PropertyValue<T, Key>> | undefined
    : Serializable<PropertyValue<T, Key>>;
};
type Serializable<T> = T extends Bytes
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Serializable<Item>[]
    : T extends object
      ? keyof SerializableObject<T> extends never
        ? object
        : SerializableObject<T>
      : T;

/** `ok: 1` is added by `ApiInterceptor`, so API handlers return the rest of the body. */
type WithoutOk<T> = T extends unknown
  ? { [Key in keyof T as Key extends 'ok' ? never : Key]: T[Key] }
  : never;

type JsonSuccess<K extends OperationId> = Exclude<SuccessBody<K>, NonJson>;
type HasNonJson<K extends OperationId> = [Extract<SuccessBody<K>, NonJson>] extends [never]
  ? false
  : true;

/**
 * Return value of an `ApiOperation` handler: the JSON success body without `ok`, or a
 * `RawResponse` when the contract declares a text or binary success body.
 */
export type ApiOperationResult<K extends OperationId> =
  Serializable<WithoutOk<JsonSuccess<K>>> | (HasNonJson<K> extends true ? RawResponse : never);

/** Return value of an `Operation` handler that writes the complete response body itself. */
export type OperationResult<K extends OperationId> =
  | Serializable<JsonSuccess<K>>
  | ([Extract<SuccessBody<K>, string>] extends [never] ? never : string)
  | ([Extract<SuccessBody<K>, Bytes>] extends [never] ? never : StreamableFile);

type Handler<Result> = (...args: never[]) => Result | Promise<Result>;
type HandlerDecorator<Result> = <Method extends Handler<Result>>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Method>,
) => void;

const METHODS = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PUT: RequestMethod.PUT,
  PATCH: RequestMethod.PATCH,
  DELETE: RequestMethod.DELETE,
  HEAD: RequestMethod.HEAD,
  OPTIONS: RequestMethod.OPTIONS,
} as const satisfies Record<string, RequestMethod>;

/** Express 5 route path of a contract path template: `{name}` -> `:name`, wildcard -> `{*name}`. */
export function routePath(operationId: OperationId): string {
  const { path, parameters } = operations[operationId];
  const wildcards = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.wildcard) wildcards.add(parameter.name);
  }
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    wildcards.has(name) ? `{*${name}}` : `:${name}`,
  );
}

function route(operationId: OperationId): MethodDecorator {
  const { method } = operations[operationId];
  return applyDecorators(
    SetMetadata(OPERATION_ID, operationId),
    RequestMapping({ path: routePath(operationId), method: METHODS[method] }),
  );
}

/**
 * A player API operation run by `ApiGuard` and `ApiInterceptor` (world lock, authentication,
 * token refresh and the `{ok: 1, ...}` envelope).
 */
export function ApiOperation<K extends OperationId>(
  operationId: K,
  policy: ApiPolicyOptions = {},
): HandlerDecorator<ApiOperationResult<K>> {
  const decorator = applyDecorators(route(operationId), ApiPolicy(policy));
  return (target, key, descriptor) => {
    decorator(target, key, descriptor);
  };
}

/** A contract operation whose handler produces the complete response body (no API envelope). */
export function Operation<K extends OperationId>(
  operationId: K,
): HandlerDecorator<OperationResult<K>> {
  const decorator = route(operationId);
  return (target, key, descriptor) => {
    decorator(target, key, descriptor);
  };
}
