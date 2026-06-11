import { describe, expect, it, vi } from 'vitest';
import { emailDeliveryConfigured, sendLoginCode, type EmailConfig } from '../src/email.js';

const resendConfig: EmailConfig = {
  mode: 'resend',
  from: 'Atrium <login@atrium.test>',
  resendApiKey: 're_test_key',
};

function okFetch(status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => ({ id: 'e1' }) }) as Response) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
}

describe('emailDeliveryConfigured', () => {
  it('log is always deliverable; resend needs key + from', () => {
    expect(emailDeliveryConfigured({ mode: 'log', from: '', resendApiKey: '' })).toBe(true);
    expect(emailDeliveryConfigured(resendConfig)).toBe(true);
    expect(emailDeliveryConfigured({ ...resendConfig, resendApiKey: '' })).toBe(false);
    expect(emailDeliveryConfigured({ ...resendConfig, from: '' })).toBe(false);
  });
});

describe('sendLoginCode', () => {
  it('log mode logs the code and never calls the network', async () => {
    const fetchImpl = okFetch();
    const logCode = vi.fn();
    await sendLoginCode('a@b.com', '123456', {
      config: { mode: 'log', from: '', resendApiKey: '' },
      fetchImpl,
      logCode,
    });
    expect(logCode).toHaveBeenCalledWith('a@b.com', '123456');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resend mode posts to the Resend API with auth and the code in the body', async () => {
    const fetchImpl = okFetch();
    await sendLoginCode('user@example.com', '987654', { config: resendConfig, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(['user@example.com']);
    expect(body.from).toBe(resendConfig.from);
    expect(body.text).toContain('987654');
  });

  it('resend mode throws on a non-2xx response and when unconfigured', async () => {
    await expect(
      sendLoginCode('user@example.com', '111111', { config: resendConfig, fetchImpl: okFetch(422) }),
    ).rejects.toThrow(/resend send failed: 422/);
    await expect(
      sendLoginCode('user@example.com', '111111', {
        config: { ...resendConfig, resendApiKey: '' },
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(/not configured/);
  });
});
