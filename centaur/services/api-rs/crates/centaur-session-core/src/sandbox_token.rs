use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use time::{Duration, OffsetDateTime};

use crate::ThreadKey;

const TOKEN_PREFIX: &str = "sbx1.";
const DEFAULT_TTL: Duration = Duration::days(7);

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SandboxTokenClaims {
    pub thread_key: ThreadKey,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, Error)]
pub enum SandboxTokenError {
    #[error("sandbox signing key is not configured")]
    MissingSigningKey,
    #[error("invalid sandbox token")]
    Invalid,
    #[error("sandbox token has expired")]
    Expired,
    #[error("failed to encode sandbox token")]
    Encode,
}

pub fn mint_sandbox_token(
    thread_key: &ThreadKey,
    signing_key: &str,
) -> Result<String, SandboxTokenError> {
    mint_sandbox_token_at(
        thread_key,
        signing_key,
        OffsetDateTime::now_utc(),
        DEFAULT_TTL,
    )
}

pub fn mint_sandbox_token_at(
    thread_key: &ThreadKey,
    signing_key: &str,
    now: OffsetDateTime,
    ttl: Duration,
) -> Result<String, SandboxTokenError> {
    let key = signing_key.trim();
    if key.is_empty() {
        return Err(SandboxTokenError::MissingSigningKey);
    }
    let claims = SandboxTokenClaims {
        thread_key: thread_key.clone(),
        iat: now.unix_timestamp(),
        exp: (now + ttl).unix_timestamp(),
    };
    let payload = serde_json::to_vec(&claims).map_err(|_| SandboxTokenError::Encode)?;
    let encoded_payload = URL_SAFE_NO_PAD.encode(payload);
    let signature = sign_payload(key, &encoded_payload)?;
    Ok(format!(
        "{TOKEN_PREFIX}{encoded_payload}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn verify_sandbox_token(
    token: &str,
    signing_key: &str,
) -> Result<SandboxTokenClaims, SandboxTokenError> {
    verify_sandbox_token_at(token, signing_key, OffsetDateTime::now_utc())
}

pub fn verify_sandbox_token_at(
    token: &str,
    signing_key: &str,
    now: OffsetDateTime,
) -> Result<SandboxTokenClaims, SandboxTokenError> {
    let key = signing_key.trim();
    if key.is_empty() {
        return Err(SandboxTokenError::MissingSigningKey);
    }
    let token = token
        .trim()
        .strip_prefix(TOKEN_PREFIX)
        .ok_or(SandboxTokenError::Invalid)?;
    let (encoded_payload, encoded_signature) =
        token.split_once('.').ok_or(SandboxTokenError::Invalid)?;
    if encoded_payload.is_empty() || encoded_signature.is_empty() {
        return Err(SandboxTokenError::Invalid);
    }

    let actual = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| SandboxTokenError::Invalid)?;
    verify_payload_signature(key, encoded_payload, &actual)?;

    let payload = URL_SAFE_NO_PAD
        .decode(encoded_payload)
        .map_err(|_| SandboxTokenError::Invalid)?;
    let claims: SandboxTokenClaims =
        serde_json::from_slice(&payload).map_err(|_| SandboxTokenError::Invalid)?;
    if claims.exp <= now.unix_timestamp() {
        return Err(SandboxTokenError::Expired);
    }
    Ok(claims)
}

fn sign_payload(signing_key: &str, encoded_payload: &str) -> Result<Vec<u8>, SandboxTokenError> {
    let mut mac = HmacSha256::new_from_slice(signing_key.as_bytes())
        .map_err(|_| SandboxTokenError::Invalid)?;
    mac.update(encoded_payload.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn verify_payload_signature(
    signing_key: &str,
    encoded_payload: &str,
    signature: &[u8],
) -> Result<(), SandboxTokenError> {
    let mut mac = HmacSha256::new_from_slice(signing_key.as_bytes())
        .map_err(|_| SandboxTokenError::Invalid)?;
    mac.update(encoded_payload.as_bytes());
    mac.verify_slice(signature)
        .map_err(|_| SandboxTokenError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_token_round_trips_thread_scope() {
        let thread_key = ThreadKey::parse("slack:C123:123.456").unwrap();
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let token =
            mint_sandbox_token_at(&thread_key, "signing-key", now, Duration::minutes(5)).unwrap();

        let claims =
            verify_sandbox_token_at(&token, "signing-key", now + Duration::minutes(1)).unwrap();

        assert_eq!(claims.thread_key, thread_key);
        assert_eq!(claims.iat, now.unix_timestamp());
        assert_eq!(claims.exp, (now + Duration::minutes(5)).unix_timestamp());
    }

    #[test]
    fn sandbox_token_rejects_wrong_key_and_expired_claims() {
        let thread_key = ThreadKey::parse("slack:C123:123.456").unwrap();
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let token =
            mint_sandbox_token_at(&thread_key, "signing-key", now, Duration::minutes(5)).unwrap();

        assert!(matches!(
            verify_sandbox_token_at(&token, "other-key", now + Duration::minutes(1)),
            Err(SandboxTokenError::Invalid)
        ));
        assert!(matches!(
            verify_sandbox_token_at(&token, "signing-key", now + Duration::minutes(6)),
            Err(SandboxTokenError::Expired)
        ));
    }
}
