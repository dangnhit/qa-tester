# BUG-SAMPLE — Profile save confirmation is absent

Status: Needs triage

Environment: Sanitized local test fixture

Supporting attempt: `ATT-SAMPLE-REDACTED`

## Expected

After a member saves a valid profile, the authoritative confirmation “Profile saved” is visible.

## Actual

No confirmation element is rendered. The browser also records a sanitized console error and failed local request.

## Evidence

- Sanitized raw screenshot and separately derived annotated screenshot
- Playwright trace
- Redacted console and network telemetry

This example contains no credentials, cookies, tokens, customer data, or real service URLs.
