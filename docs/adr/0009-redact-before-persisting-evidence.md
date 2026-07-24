# Redact protected evidence before persistence

For protected environments, mandatory redaction occurs before an artifact is persisted, so “raw” means **Sanitized Raw Evidence** without annotations rather than unmodified production pixels. Annotated artifacts derive only from that sanitized source; when screenshots, traces, console entries, or network records cannot be scrubbed safely, capture is disabled and an explicit **Evidence Gap** replaces the unsafe artifact.

This binds every channel, not only screenshots. A trace or other archive embeds DOM and network content that no channel can prove was masked against a declared redaction target, so an archive is retained only when the **Environment Profile** permits it, no secret has been resolved, and no redaction target is declared; otherwise it is refused as an **Evidence Gap**. ADR-0010 extends the same rule to runner-produced archives in the human-authored lane.
