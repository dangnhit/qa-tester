# Preserve immutable and linked QA runs

Every retest, regression, or cleanup retry creates a new **QA Run** linked to its source run, bug, change scope, or resource manifest, and every execution produces an immutable **Test Attempt**. Only a running manifest may advance to a terminal status; completed artifacts are never overwritten, preserving failure evidence and a trustworthy audit trail across fixes. A **Cleanup Run** may change only external resources still owned by its source run, never the source artifacts themselves.
