# Security Policy

## Supported version

The current `1.0.x` line receives security fixes. Pre-1.0 development versions receive none; a `0.1.x` installation should be moved onto `1.0.x`, whose public contract — the named exports of `@dangnhit/qa-skills` and the documented CLI commands, flags, and exit codes — is frozen for the whole `1.x` range.

Pin an exact package version or commit, and verify the local runtime binding before execution:

```bash
qa-skill runtime verify --range ">=1.0.0 <2.0.0"
qa-skill skills verify --agent <codex|claude|cursor>
```

A `runtime-missing`, `runtime-changed`, or `runtime-incompatible` status means the installed skills no longer name the binary that wrote them. Treat it as a review event, not as something to clear with `--force`.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, leaked secret, unsafe evidence artifact, path escape, or side-effect bypass. Report it privately through GitHub: **Security → Advisories → Report a vulnerability** on [this repository](https://github.com/dangnhit/qa-tester/security/advisories/new). The report stays private to you and the maintainer until an advisory is published. Include:

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
