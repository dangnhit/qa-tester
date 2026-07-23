# Contributing

Thank you for improving QA Skills.

## Development

Use Node.js 22 or 24. Install exact dependencies and Chromium:

```bash
npm ci
npx playwright install chromium
```

Make changes on a focused branch. Preserve the vocabulary and invariants in `CONTEXT.md`: schemas define machine contracts, canonical artifacts are immutable, the Run Artifact Manifest is authoritative, and agent reasoning never bypasses runtime validation.

Use test-driven development for behavior changes. Capture a failing focused test, implement the smallest complete change, then run:

```bash
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run demo
npm run build
```

Generated contract types must match `shared/schemas`. Tests must use public seams and deterministic localhost fixtures; do not rely on external networks, real accounts, clocks without control, or shared browser state.

## Security and privacy

Never commit secrets, resolved Secret References, cookies, customer data, production screenshots, or real service payloads. Examples must use synthetic identifiers and sanitized evidence. New side effects require typed safety policy and cleanup coverage.

## Pull requests

Describe the user-visible behavior, RED/GREEN evidence, contract or migration impact, and safety implications. Keep documentation and English/Vietnamese executable setup current. Contributions are accepted under Apache-2.0.
