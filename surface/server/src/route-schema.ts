import { Either, Schema } from 'effect';
import { DomainError } from './events.js';

export interface DecodeRouteInputOptions {
  code?: string;
  message?: string;
  statusCode?: number;
}

export function decodeRouteInput<A, I = A>(
  schema: Schema.Schema<A, I, never>,
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

export function decodeRouteBody<A, I = A>(
  schema: Schema.Schema<A, I, never>,
  body: unknown,
  options?: DecodeRouteInputOptions,
): A {
  return decodeRouteInput(schema, routeBodyRecord(body), options);
}

function validationMessage(_error: { message?: string }): string {
  return 'invalid request body';
}

function routeBodyRecord(body: unknown): unknown {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}
