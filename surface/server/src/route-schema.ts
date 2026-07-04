import { Either, Schema } from 'effect';
import { DomainError } from './events.js';

export interface DecodeRouteInputOptions {
  code?: string;
  message?: string;
  statusCode?: number;
}

interface DecodeRouteInputInternalOptions extends DecodeRouteInputOptions {
  defaultMessage?: string;
}

export function decodeRouteInput<A, I = A>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
  options: DecodeRouteInputInternalOptions = {},
): A {
  const decoded = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(decoded)) return decoded.right;
  throw new DomainError(
    options.statusCode ?? 400,
    options.code ?? 'bad_request',
    options.message ?? validationMessage(options.defaultMessage),
  );
}

export function decodeRouteBody<A, I = A>(
  schema: Schema.Schema<A, I, never>,
  body: unknown,
  options?: DecodeRouteInputOptions,
): A {
  return decodeRouteInput(schema, routeRecord(body), {
    ...options,
    defaultMessage: 'invalid request body',
  });
}

export function decodeRouteQuery<A, I = A>(
  schema: Schema.Schema<A, I, never>,
  query: unknown,
  options?: DecodeRouteInputOptions,
): A {
  return decodeRouteInput(schema, routeRecord(query), {
    ...options,
    defaultMessage: 'invalid request query',
  });
}

export function decodeRouteParams<A, I = A>(
  schema: Schema.Schema<A, I, never>,
  params: unknown,
  options?: DecodeRouteInputOptions,
): A {
  return decodeRouteInput(schema, routeRecord(params), {
    ...options,
    defaultMessage: 'invalid request params',
  });
}

function validationMessage(defaultMessage = 'invalid request input'): string {
  return defaultMessage;
}

function routeRecord(input: unknown): unknown {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}
