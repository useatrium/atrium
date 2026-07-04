import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { DomainError } from '../src/events.js';
import { decodeRouteBody, decodeRouteInput } from '../src/route-schema.js';

describe('route schema decoding', () => {
  it('returns typed decoded input', () => {
    const Body = Schema.Struct({
      channelId: Schema.String,
      private: Schema.optional(Schema.Boolean),
    });

    expect(decodeRouteInput(Body, { channelId: 'c1', private: true })).toEqual({
      channelId: 'c1',
      private: true,
    });
  });

  it('throws a DomainError for invalid input', () => {
    const Body = Schema.Struct({ token: Schema.String });

    expect(() => decodeRouteBody(Body, { token: 1 })).toThrow(DomainError);
    try {
      decodeRouteBody(Body, { token: 1 }, { code: 'invalid_push_registration' });
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).statusCode).toBe(400);
      expect((err as DomainError).code).toBe('invalid_push_registration');
      expect((err as Error).message).toBe('invalid request body');
    }
  });

  it('treats non-object bodies as empty objects', () => {
    const Body = Schema.Struct({});
    expect(decodeRouteBody(Body, null)).toEqual({});
    expect(decodeRouteBody(Body, undefined)).toEqual({});
    expect(decodeRouteBody(Body, 'not an object')).toEqual({});
    expect(decodeRouteBody(Body, [])).toEqual({});
  });

  it('preserves required-field failures after non-object normalization', () => {
    expect.assertions(3);
    const Body = Schema.Struct({ token: Schema.String });

    try {
      decodeRouteBody(Body, 'not an object', { message: 'token required' });
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('bad_request');
      expect((err as Error).message).toBe('token required');
    }
  });
});
