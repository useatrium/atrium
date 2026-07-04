import { Either, Schema } from 'effect';
import { DomainError } from './events.js';

export interface DecodeRouteInputOptions {
  code?: string;
  message?: string;
  statusCode?: number;
}

export function decodeRouteInput<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  options: DecodeRouteInputOptions = {},
): A {
  const decoded = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(decoded)) return decoded.right;
  throw new DomainError(
    options.statusCode ?? 400,
    options.code ?? 'bad_request',
    options.message ?? validationMessage(decoded.left),
  );
}

export function decodeRouteBody<A>(
  schema: Schema.Schema<A>,
  body: unknown,
  options?: DecodeRouteInputOptions,
): A {
  return decodeRouteInput(schema, routeBodyRecord(body), options);
}

function validationMessage(error: { message?: string }): string {
  const firstLine = typeof error.message === 'string' ? error.message.split('\n')[0]?.trim() : '';
  return firstLine || 'invalid request body';
}

function routeBodyRecord(body: unknown): unknown {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}
