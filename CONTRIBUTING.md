# Contributing

Thank you for improving QA Skills.

## Development

Use Node.js 22 or 24. Install exact dependencies and Chromium:

```bash
npm ci
npx playwright install chromium
```

Make changes on a focused branch. Preserve the vocabulary and invariants in `CONTEXT.md`: schemas define machine contracts, canonical artifacts are immutable, the Run Artifact Manifest is authoritative, and agent reasoning never bypasses runtime validation.

Install the repository hooks once per clone:

```bash
npm run hooks:install
```

## Language

Everything authored in this repository is written in English: commit messages, code, comments, documentation, issues, and pull requests. There is exactly one exception, and it is product data rather than prose -- the **Artifact Locale** feature renders reports in a requested language, so `src/reporting/render-markdown.ts`, `shared/templates/report.vi.md`, `tests/fixtures/report-golden.vi.md`, and the two tests asserting that projection legitimately contain Vietnamese. `CONTEXT.md` pins the boundary: an Artifact Locale changes the human-readable projection only, while canonical machine values stay English.

`npm run scan:language` enforces the rule over tracked files, the `commit-msg` hook enforces it over the message you are about to write, and CI enforces both plus the whole commit history. The scanner rejects the Vietnamese alphabet specifically, not every non-ASCII character, because English prose here uses em dashes and typographic quotes. A character-level scanner cannot see unaccented Vietnamese, so the rule -- not the tool -- is the contract.

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

Describe the user-visible behavior, RED/GREEN evidence, contract or migration impact, and safety implications. Keep documentation and executable setup current. Contributions are accepted under Apache-2.0.
