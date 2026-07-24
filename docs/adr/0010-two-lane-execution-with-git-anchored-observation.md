# Two execution lanes, anchored by authorship

A test result may satisfy a **Coverage Obligation** only when the **QA Runtime** observed the run that produced it, so QA Skills accepts two lanes and refuses everything else. In the agent-authored lane the runtime drives the **Runtime Browser Driver** over a bounded **Test DSL** and records `runtime-execution`; in the human-authored lane the runtime spawns an external runner over git-committed spec files, captures that process's exit status and output itself, and records `runtime-observed` together with the commit SHA and spec-tree checksum. A result file merely handed to the runtime stays an **Agent Draft** and never credits coverage, however much evidence accompanies it.

## Considered Options

Accepting results the agent supplies directly was rejected: it would let an agent fabricate a passing report and defeat the **Requirement Authority** model, which is the property this product exists to guarantee. Letting the agent author external spec files was rejected because an arbitrary TypeScript spec bypasses ADR-0008's bounded DSL, the **Approval Policy**, and the **Side-effect Class** checks in one step — and would do so while earning coverage credit. Anchoring the human lane on `qa-skill approval record` rather than git was rejected as ceremony teams would automate away; git commit identity is the review anchor they already trust and it is verifiable by hash.

## Consequences

The runtime must refuse to spawn, or must downgrade to `agent-draft`, any run whose spec directory is dirty relative to its recorded commit. An agent that wants a new external test opens a pull request; it cannot execute that test with coverage credit until a human merges it. The human lane inherits the external runner's authentication, retry, sharding, and fixture capabilities, which is why AUTH-1, FLAKE-1, and SCALE-2 are no longer QA Skills' problems to solve.
