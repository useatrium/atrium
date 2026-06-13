import { AccessToken } from 'livekit-server-sdk';

export interface LiveKitConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

export interface CallTokenService {
  url: string;
  mintToken(room: string, identity: string, name: string): Promise<string>;
}

export function createLiveKitTokenService(config: LiveKitConfig): CallTokenService | null {
  const url = config.livekitUrl.trim();
  const apiKey = config.livekitApiKey.trim();
  const apiSecret = config.livekitApiSecret.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return {
    url,
    mintToken: (room, identity, name) => mintToken({ apiKey, apiSecret }, room, identity, name),
  };
}

export async function mintToken(
  config: Pick<LiveKitConfig, 'livekitApiKey' | 'livekitApiSecret'> | { apiKey: string; apiSecret: string },
  room: string,
  identity: string,
  name: string,
): Promise<string> {
  const apiKey = 'apiKey' in config ? config.apiKey : config.livekitApiKey;
  const apiSecret = 'apiSecret' in config ? config.apiSecret : config.livekitApiSecret;
  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '1h' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
