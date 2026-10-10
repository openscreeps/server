/*
 * Contract conformance harness: validates every HTTP exchange of the generated OpenScreeps client
 * against the composed contract (`api/openapi.json`). It observes responses through the client's
 * injectable `fetch`, so the server under test runs unmodified and pays no validation cost.
 */

import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { operationIds, operations, type OperationId } from '../src/generated/api/index.ts';

interface Reference {
  $ref: string;
}
interface MediaTypeObject {
  schema?: unknown;
}
interface ResponseObject {
  content?: Record<string, MediaTypeObject>;
}
export interface OperationObject {
  operationId: string;
  responses: Record<string, ResponseObject | Reference>;
  'x-profile'?: { status: string; reason?: string };
}
export interface ContractDocument {
  paths: Record<string, Record<string, OperationObject>>;
  components: Record<string, Record<string, unknown>>;
}

export const contract = JSON.parse(
  readFileSync(new URL('../api/openapi.json', import.meta.url), 'utf8'),
) as ContractDocument;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Every operation of the composed document, keyed by operationId. */
export function contractOperations(): Map<string, { method: string; path: string }> {
  const result = new Map<string, { method: string; path: string }>();
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (result.has(operation.operationId)) {
        throw new Error(`duplicate operationId ${operation.operationId}`);
      }
      result.set(operation.operationId, { method: method.toUpperCase(), path });
    }
  }
  return result;
}

function resolveReference<T>(value: T | Reference): T {
  let current: unknown = value;
  while (typeof current === 'object' && current !== null && '$ref' in current) {
    const reference = (current as Reference).$ref;
    if (!reference.startsWith('#/')) throw new Error(`external reference ${reference}`);
    current = reference
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], contract);
  }
  return current as T;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajvFormats.default(ajv);
// OpenAPI-only formats describe encodings, not JSON Schema string constraints.
for (const format of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password']) {
  ajv.addFormat(format, true);
}
const validators = new Map<unknown, ValidateFunction>();

/** Validator of one schema of the composed document; `#/components/...` references resolve. */
export function schemaValidator(schema: unknown): ValidateFunction {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile({
      ...(schema as Record<string, unknown>),
      components: contract.components,
    });
    validators.set(schema, validate);
  }
  return validate;
}

/** Validator of a named component schema of the composed document. */
export function componentValidator(name: string): ValidateFunction {
  const schema = contract.components['schemas']?.[name];
  if (schema === undefined) throw new Error(`missing component schema ${name}`);
  return schemaValidator(schema);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Request path patterns of the generated operation manifest (the client's own routing table). */
const routes = operationIds.map((operationId) => {
  const { method, path, parameters } = operations[operationId];
  const wildcards = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.wildcard) wildcards.add(parameter.name);
  }
  const source = path
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const name = /^\{([^}]+)\}$/.exec(part)?.[1];
      if (name === undefined) return escapeRegExp(part);
      return wildcards.has(name) ? '.+' : '[^/]+';
    })
    .join('');
  return { operationId, method: method.toUpperCase(), pattern: new RegExp(`^${source}$`) };
});

function matchOperation(method: string, pathname: string): OperationId | undefined {
  return routes.find((route) => route.method === method && route.pattern.test(pathname))
    ?.operationId;
}

function declaredMedia(
  content: Record<string, MediaTypeObject>,
  contentType: string,
): MediaTypeObject | undefined {
  const [type] = contentType.split('/');
  return content[contentType] ?? content[`${type ?? ''}/*`] ?? content['*/*'];
}

function isJsonMedia(contentType: string): boolean {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

export interface Exchange {
  operationId: OperationId;
  status: number;
  /** A JSON body carrying the protocol's `{error}` envelope (any HTTP status). */
  error?: string;
}

/**
 * Records and validates each response the client receives: the route and HTTP status must be
 * declared by the contract, the media type declared for that status, and JSON bodies must match
 * the declared schema. Bodies are never logged (they can hold tokens or private Memory).
 */
export class ContractRecorder {
  readonly exchanges: Exchange[] = [];
  readonly failures: string[] = [];
  readonly #fetch: typeof fetch;

  constructor(base: typeof fetch) {
    this.#fetch = base;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await this.#fetch(request);
    await this.#record(request, response.clone());
    return response;
  };

  async #record(request: Request, response: Response): Promise<void> {
    const { pathname } = new URL(request.url);
    const label = `${request.method} ${pathname} HTTP ${String(response.status)}`;
    const operationId = matchOperation(request.method, pathname);
    if (operationId === undefined) {
      this.failures.push(`${label}: route is not in the contract`);
      return;
    }
    const exchange: Exchange = { operationId, status: response.status };
    this.exchanges.push(exchange);
    const { method, path } = operations[operationId];
    const operation = contract.paths[path]?.[method.toLowerCase()];
    if (!operation) {
      this.failures.push(`${label}: ${operationId} is missing from api/openapi.json`);
      return;
    }
    const status = String(response.status);
    const declared =
      operation.responses[status] ??
      operation.responses[`${status.charAt(0)}XX`] ??
      operation.responses['default'];
    if (declared === undefined) {
      this.failures.push(`${label}: ${operationId} does not declare this status`);
      return;
    }
    const content = resolveReference(declared).content;
    const body = Buffer.from(await response.arrayBuffer());
    if (content === undefined) {
      if (body.length) this.failures.push(`${label}: ${operationId} declares no body`);
      return;
    }
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    const media = contentType ? declaredMedia(content, contentType) : undefined;
    if (contentType === undefined || media === undefined) {
      this.failures.push(`${label}: ${operationId} does not declare ${contentType ?? 'untyped'}`);
      return;
    }
    if (!isJsonMedia(contentType)) return;
    let data: unknown;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      this.failures.push(`${label}: ${operationId} returned malformed JSON`);
      return;
    }
    if (typeof data === 'object' && data !== null && 'error' in data) {
      exchange.error = String(data.error);
    }
    if (media.schema === undefined) return;
    const validate = schemaValidator(media.schema);
    if (!validate(data)) {
      this.failures.push(
        `${label}: ${operationId} ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
      );
    }
  }

  /** Operations of the contract without a single exchange, sorted. */
  unexercised(): string[] {
    const seen = new Set(this.exchanges.map((exchange) => exchange.operationId));
    return [...contractOperations().keys()].filter((id) => !seen.has(id as OperationId)).sort();
  }

  /** Operations of `expected` that never produced a 2xx response without an error envelope. */
  unsuccessful(expected: Iterable<string>): string[] {
    const succeeded = new Set(
      this.exchanges
        .filter((exchange) => exchange.status < 300 && exchange.error === undefined)
        .map((exchange) => exchange.operationId),
    );
    return [...expected].filter((id) => !succeeded.has(id as OperationId)).sort();
  }
}
