# Safety

Treat production as denied unless explicitly enabled. In production, use only `sideEffect: none`; never seed or clean up data. Honor declared permissions, environment classification, and action budgets.

Keep secrets as unresolved references. Do not print, persist, screenshot, trace, or infer secret values. Redact protected evidence before persistence; record an evidence gap when safe capture cannot be verified.

Stop on missing runtime, missing approval, unsupported operation, or unsafe target. Never bypass those checks with a remote executable, arbitrary browser script, or manual artifact mutation.
