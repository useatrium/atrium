import { describe, expect, it } from 'vitest';
import {
  claudeExecutionEnvironment,
  codexExecutionEnvironment,
  isClaudeAuthFailureText,
  isCodexAuthFailureText,
  normalizeClaudeToken,
  normalizeCodexAuthJson,
  providerForHarness,
} from './provider-credentials.js';

describe('normalizeCodexAuthJson', () => {
  const validAuth = JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc' },
  });

  it('accepts a ChatGPT-mode auth.json and pins OPENAI_API_KEY to null', () => {
    const out = JSON.parse(normalizeCodexAuthJson(validAuth));
    expect(out.auth_mode).toBe('chatgpt');
    expect(out.OPENAI_API_KEY).toBeNull();
    expect(out.tokens.access_token).toBe('at');
  });

  it('rejects an auth.json carrying an OPENAI_API_KEY', () => {
    expect(() =>
      normalizeCodexAuthJson(
        JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-x', tokens: { access_token: 'a' } }),
      ),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('rejects a non-chatgpt auth_mode', () => {
    expect(() =>
      normalizeCodexAuthJson(JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'a' } })),
    ).toThrow(/auth_mode/);
  });

  it('rejects a missing access_token', () => {
    expect(() => normalizeCodexAuthJson(JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }))).toThrow(
      /access_token/,
    );
  });

  it('rejects non-JSON input', () => {
    expect(() => normalizeCodexAuthJson('not json')).toThrow(/valid JSON/);
  });
});

describe('normalizeClaudeToken', () => {
  it('accepts and trims a setup-token', () => {
    expect(normalizeClaudeToken('  sk-ant-oat01-abc  ')).toBe('sk-ant-oat01-abc');
  });

  it('rejects an empty token', () => {
    expect(() => normalizeClaudeToken('   ')).toThrow(/required/);
  });

  it('rejects an API key with a pointer to setup-token', () => {
    expect(() => normalizeClaudeToken('sk-ant-api03-xyz')).toThrow(/setup-token/);
  });
});

describe('execution environment helpers', () => {
  it('injects the Codex auth.json under CODEX_AUTH_JSON', () => {
    expect(codexExecutionEnvironment('{"a":1}')).toEqual({ CODEX_AUTH_JSON: '{"a":1}' });
  });

  it('injects the Claude subscription token under CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(claudeExecutionEnvironment('sk-ant-oat01-abc')).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc',
    });
  });
});

describe('providerForHarness', () => {
  it('maps harness names to providers and ignores unknown harnesses', () => {
    expect(providerForHarness('codex')).toBe('codex');
    expect(providerForHarness('claude-code')).toBe('claude-code');
    expect(providerForHarness('amp')).toBeNull();
  });
});

describe('auth-failure detection', () => {
  it('flags Codex login failures and Claude bearer failures', () => {
    expect(isCodexAuthFailureText('codex: not logged in')).toBe(true);
    expect(isClaudeAuthFailureText('401 invalid bearer token from anthropic')).toBe(true);
  });
});
