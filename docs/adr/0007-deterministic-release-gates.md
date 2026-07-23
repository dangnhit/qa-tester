# Generate release recommendations with deterministic gates

Validated artifacts and configured obligations are evaluated by a deterministic **Release Gate** that emits `READY`, `READY_WITH_RISKS`, or `NOT_READY` together with every rule input and verdict; AI generates only the narrative explanation. An authorized **Release Override** is recorded separately instead of changing the original recommendation, preserving reproducibility while allowing explicit business risk acceptance.
