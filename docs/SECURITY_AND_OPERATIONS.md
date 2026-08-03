# Security and Operations

## Implemented controls

- Organisation scoping on authenticated resources
- JWT authentication and rate limiting
- Direct uploads using short-lived signed URLs
- Private source and working buckets
- Immutable design versions and audit events
- Checksum verification for Mode B evidence packages
- Public promotion only after designer/site confirmation
- Expiring and revocable client links
- Unpublish support

## Required before production

- Replace development OTP disclosure with a real SMS provider
- Rotate all example secrets
- Use managed PostgreSQL/Redis/object storage or hardened equivalents
- Add malware scanning and stronger PII/document/text detection
- Add backups, restore drills and object-retention policies
- Add OpenTelemetry, metrics, alerting and central logs
- Add CI image scanning and dependency update automation
- Define regional privacy, deletion and consent policies
- Place APIs and storage behind HTTPS
