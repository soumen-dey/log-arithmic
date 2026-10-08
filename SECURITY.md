# Security policy

## Supported versions

Only the latest published release receives security fixes before Log Arithmic 1.0.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's
private vulnerability reporting for this repository, or contact the project
maintainers privately. Include affected versions, impact, and a reproducible
report where possible. Do not include production credentials or customer data.

## Operational guidance

- Bind to loopback unless remote access is needed; terminate TLS at a trusted
  reverse proxy for remote deployments.
- Use a unique, high-entropy `LOG_ARITHMIC_ADMIN_TOKEN`. If one is generated for
  local development, keep the ignored `*.admin-token` file private; it contains
  the admin credential in plaintext so the token survives restarts.
- Create a separate scoped API key for each project/environment and revoke
  compromised keys.
- Protect the SQLite data directory and back it up using SQLite-aware tooling.
