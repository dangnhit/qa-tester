# Redact protected evidence before persistence

For protected environments, mandatory redaction occurs before an artifact is persisted, so “raw” means **Sanitized Raw Evidence** without annotations rather than unmodified production pixels. Annotated artifacts derive only from that sanitized source; when screenshots, traces, console entries, or network records cannot be scrubbed safely, capture is disabled and an explicit **Evidence Gap** replaces the unsafe artifact.
