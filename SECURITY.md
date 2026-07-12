# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability** (or go directly to
https://github.com/useatrium/atrium/security/advisories/new).

Do not open public issues for suspected vulnerabilities until we have had a
chance to investigate and coordinate a fix.

When possible, include:

- affected version or commit
- deployment shape, for example local Docker, desktop, or Centaur-backed cluster
- reproduction steps
- expected impact
- any logs or traces with secrets removed

We will acknowledge reports within 7 days and follow up with the expected fix or
disclosure path after triage.

## Supported Versions

Before the first stable release, only the `master` branch is supported for
security fixes. Once tagged releases begin, this file will list supported release
lines.

## Secrets

Never include provider tokens, API keys, OAuth refresh tokens, database
passwords, session cookies, or private keys in a public issue, pull request, log,
or artifact. If a secret may have been exposed, rotate it before sharing the
report.
