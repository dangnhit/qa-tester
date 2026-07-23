# Security Policy

## Supported version

The current `0.1.x` development line receives security fixes. Until a stable release exists, use a pinned commit or package version and verify the local runtime binding before execution.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, leaked secret, unsafe evidence artifact, path escape, or side-effect bypass. Report it privately to `security@vigentix.dev` with:

- affected version or commit
- impact and reproducible conditions
- sanitized logs or artifacts only
- suggested mitigation, if known

Do not include credentials, session state, customer data, or unredacted screenshots. We will acknowledge receipt, coordinate validation and remediation, and publish an advisory when users can act safely.

## Operational guidance

- Run QA Skills with the least filesystem and network privileges needed.
- Pin dependencies and install browsers during controlled setup.
- Treat Skill Installation drift as a review event.
- Permit production only through explicit read-only policy.
- Keep resolved secrets in memory and register Evidence Gaps when redaction cannot be proven.
- Retain canonical manifests and checksums when sharing a sanitized reproduction.
