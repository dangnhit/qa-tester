# Third-party content in this directory

`sarif-2.1.0-schema.json` is **not** part of QA Skills and is **not** covered by this
repository's Apache-2.0 license. It is a third-party standards artifact, redistributed here
under the terms below.

## What it is

The JSON Schema for the Static Analysis Results Interchange Format (SARIF) Version 2.1.0, an
OASIS Standard produced by the OASIS Static Analysis Results Interchange Format (SARIF)
Technical Committee.

The document self-identifies through its own `$id`:

```json
"$id": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json"
```

## Copyright and terms

> Copyright © OASIS Open. All Rights Reserved.

Content in the `oasis-tcs/sarif-spec` repository is governed by the OASIS policies, including
the OASIS Intellectual Property Rights (IPR) Policy:
<https://www.oasis-open.org/policies-guidelines/ipr>

That policy permits this redistribution. Section 14.1 states that derivative works "that comment
on or otherwise explain it or assist in its implementation may be prepared, copied, published,
and distributed", on the condition that "the above copyright notice and this section are included
on all such copies and derivative works" — which is what this file exists to satisfy — and that
"this document itself may not be modified in any way, including by removing the copyright notice
or references to OASIS".

**This project has not modified the document.** It was committed once, in `d1938df`
(2026-07-30), and no commit has touched this directory since.

## Provenance

| | |
| --- | --- |
| Retrieved from | `https://json.schemastore.org/sarif-2.1.0.json` |
| Retrieved on | 2026-07-30 |
| Committed in | `d1938df` |
| Bytes | 111,720 |

The retrieval URL and the document's own `$id` name two different distributors of the same
artifact. The bytes came from SchemaStore; the `$id` names the OASIS repository the schema
originates from. Both are recorded here rather than silently reconciled, because only one of
them is where these bytes were actually fetched.

## Why it is here, and where it does not go

It is a **test fixture only**. `tests/reporting/projections/sarif.test.ts` and
`tests/reporting/projections/spec-locations.test.ts` validate this project's SARIF output
against it, so that a claim of SARIF 2.1.0 conformance is checked against the real schema rather
than against an assumption.

It is **not** shipped in the npm package: `package.json`'s `files` field is `["dist", "skills",
"NOTICE"]`, and `fixtures/` is not among them. No published tarball contains it.
