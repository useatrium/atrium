use std::path::Path;
use std::sync::LazyLock;

use regex::bytes::Regex;

pub const SECRET_SCAN_BYTES: usize = 64 * 1024;

const SECRET_NAME_PATTERNS: &[&str] = &[".env", "*.key", "*.p8", "*.pem", ".netrc", "id_rsa"];
const SECRET_PATH_SUFFIXES: &[&str] = &[".aws/credentials"];
const SECRET_CONTENT_PATTERNS: &[&str] = &[
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"\bAWS_SECRET_ACCESS_KEY\s*=",
    r"\b(AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bOPENAI_API_KEY\s*=",
    r"\bANTHROPIC_API_KEY\s*=",
    r"\bSLACK_BOT_TOKEN\s*=",
    r"\bsk-[A-Za-z0-9_-]{20,}\b",
    r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
    r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b",
];

static SECRET_CONTENT_REGEXES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    SECRET_CONTENT_PATTERNS
        .iter()
        .map(|pattern| Regex::new(pattern).expect("valid secret content regex"))
        .collect()
});

pub fn is_secret(rel_path: &Path, sample: &[u8]) -> bool {
    let Some(name) = rel_path.file_name() else {
        return false;
    };
    let name = name.to_string_lossy().to_ascii_lowercase();
    if SECRET_NAME_PATTERNS
        .iter()
        .any(|pattern| secret_name_matches(&name, pattern))
    {
        return true;
    }

    let normalized = rel_path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if SECRET_PATH_SUFFIXES
        .iter()
        .any(|suffix| normalized.contains(suffix))
    {
        return true;
    }

    SECRET_CONTENT_REGEXES
        .iter()
        .any(|pattern| pattern.is_match(sample))
}

fn secret_name_matches(name: &str, pattern: &str) -> bool {
    pattern
        .strip_prefix('*')
        .map_or(name == pattern, |suffix| name.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secret_content_patterns() {
        assert!(is_secret(
            Path::new("notes.txt"),
            b"ANTHROPIC_API_KEY=sk-ant-api03-placeholder"
        ));
        assert!(is_secret(
            Path::new("logs/output.txt"),
            b"client_id=abc\naws_key=AKIA1234567890ABCDEF\n"
        ));
        assert!(is_secret(
            Path::new("env.txt"),
            b"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        ));
    }

    #[test]
    fn detects_secret_file_names() {
        assert!(is_secret(Path::new(".env"), b""));
        assert!(is_secret(Path::new("certs/client.pem"), b""));
    }

    #[test]
    fn allows_plain_reports() {
        assert!(!is_secret(
            Path::new("report.md"),
            b"# Report\nNo credentials here.\n"
        ));
    }
}
