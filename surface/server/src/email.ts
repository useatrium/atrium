// Login-code delivery. EMAIL_MODE selects the transport:
//   log    — write the code to the server log (dev only; gated on AUTH_DEV_CODES
//            at the call site so prod never leaks a live code)
//   resend — POST to the Resend HTTP API (no SDK dependency)
// Adding SMTP later means another branch here; the call site is unchanged.

export type EmailMode = 'log' | 'resend';

export interface EmailConfig {
  mode: EmailMode;
  /** From address, e.g. "Atrium <login@yourdomain>". Required for resend. */
  from: string;
  /** Resend API key (resend mode only). */
  resendApiKey: string;
}

export interface EmailDeps {
  config: EmailConfig;
  fetchImpl?: typeof fetch;
  /** Dev convenience: also log the code (gated by AUTH_DEV_CODES upstream). */
  logCode?: (email: string, code: string) => void;
}

const RESEND_URL = 'https://api.resend.com/emails';

/** True when the configured transport can actually deliver a code. */
export function emailDeliveryConfigured(config: EmailConfig): boolean {
  if (config.mode === 'resend') return config.resendApiKey.length > 0 && config.from.length > 0;
  return config.mode === 'log';
}

function bodyText(code: string): string {
  return `Your Atrium sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`;
}

/**
 * Deliver a 6-digit login code. Throws on a hard transport failure so the
 * caller can log it; the caller still returns a generic success so the
 * response can't be used to probe which addresses are registered.
 */
export async function sendLoginCode(email: string, code: string, deps: EmailDeps): Promise<void> {
  const { config } = deps;
  if (config.mode === 'log') {
    deps.logCode?.(email, code);
    return;
  }
  if (config.mode === 'resend') {
    if (!config.resendApiKey || !config.from) {
      throw new Error('resend transport not configured (RESEND_API_KEY / EMAIL_FROM)');
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [email],
        subject: 'Your Atrium sign-in code',
        text: bodyText(code),
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status}`);
    }
    return;
  }
  throw new Error(`unknown EMAIL_MODE: ${config.mode as string}`);
}
