# QA Skills

This context defines a portable quality-assurance system that AI coding agents can use to plan, execute, and report software tests consistently.

## Language

**QA Skills**:
The complete portable QA system comprising the runtime, CLI, contracts, skill bundle, and generated artifacts.
_Avoid_: QA Tester, qa-tester

**QA Tester**:
The orchestrator **Skill Adapter** that selects and composes QA operations for a requested workflow mode.
_Avoid_: QA Skills, QA Runtime

**QA Runtime**:
The deterministic TypeScript engine that owns QA orchestration, browser execution, artifact validation, and report generation.
_Avoid_: Skill engine, agent runtime

**Skill Adapter**:
A thin agent-facing instruction package that translates a QA request into operations supported by the **QA Runtime**.
_Avoid_: Skill implementation, QA engine

**Runtime Browser Driver**:
The Playwright-based executable browser capability controlled directly by the **QA Runtime**.
_Avoid_: Built-in browser, browser tool

**Agent Browser Adapter**:
Agent-facing instructions for using an available built-in browser or MCP browser while producing artifacts compatible with the **QA Runtime**.
_Avoid_: Runtime driver, Playwright wrapper

**QA Run**:
An immutable execution envelope with one mode, scope, target environment, and terminal outcome.
_Avoid_: Test session, mutable result folder

**Test Attempt**:
An immutable record of one execution of one test case within a **QA Run**.
_Avoid_: Test result, retry

**Execution Status**:
The observed outcome of executing or scheduling a test case, independent of its diagnosed cause.
_Avoid_: Defect type, root cause

**Failure Classification**:
The diagnosed source of a non-passing outcome: product, test, environment, or undetermined.
_Avoid_: Execution status, severity

**Test Incident**:
An evidence-backed report of a test definition, automation, or test-data failure that prevents a trustworthy product conclusion.
_Avoid_: Product bug, failed assertion

**Environment Incident**:
An evidence-backed report of a target or test-infrastructure condition that prevents reliable execution.
_Avoid_: Product bug, test incident

**Investigation Finding**:
A non-passing observation whose failure classification remains undetermined and requires further diagnosis.
_Avoid_: Product bug, exploratory finding

**Requirement Statement**:
A uniquely identified claim about expected product behavior, preserved with its source and authority level.
_Avoid_: Assumption, test expectation

**Requirement Authority**:
The confidence category attached to a **Requirement Statement**: authoritative, inferred, assumed, or conflicting.
_Avoid_: Test priority, requirement status

**Test Case**:
A stable, uniquely identified testing intent that can evolve through revisions.
_Avoid_: Test attempt, test script

**Test Case Revision**:
An immutable fingerprint and snapshot of the executable content of a **Test Case**.
_Avoid_: Test case ID, attempt number

**Test Case Instance**:
A concrete expansion of one **Test Case Revision** with a declared parameter set and browser-matrix member.
_Avoid_: Test case, test attempt

**Evidence Item**:
An immutable, checksummed artifact that substantiates a specific observation or execution claim.
_Avoid_: Attachment, screenshot

**Evidence Manifest**:
The provenance record that links all **Evidence Items** to their run, attempt, test case, and optional bug.
_Avoid_: Evidence folder, file listing

**Run Artifact Manifest**:
The authoritative checksummed index of every typed artifact and relationship in one **Run Workspace**.
_Avoid_: Directory layout, latest-file discovery

**Full QA Lifecycle**:
A QA workflow that covers requirement authority, risk-based test design, controlled test data, execution, evidence, defect handling, and reporting.
_Avoid_: Browser test, end-to-end test

**Environment Profile**:
An explicit declaration of a test target's identity, classification, and safety constraints.
_Avoid_: Base URL, environment name

**Side-effect Class**:
The declared impact category of a test step: none, reversible, external, or destructive.
_Avoid_: Risk level, test type

**Secret Reference**:
An unresolved pointer to a credential or session resource owned outside the QA artifact boundary.
_Avoid_: Credential value, test data

**Run Workspace**:
The runtime-managed boundary that registers typed inputs, phase outputs, and lifecycle state for one **QA Run**.
_Avoid_: Results directory, working directory

**QA Operation**:
An independently callable typed capability used identically by a standalone **Skill Adapter** and an orchestrated workflow.
_Avoid_: Skill chain, pipeline script

**Execution Kind**:
The declared way a skill produces results: agent-authored, runtime-backed, or hybrid.
_Avoid_: Workflow mode, skill type

**Artifact Contract**:
The versioned JSON Schema definition governing a machine-readable QA input or output.
_Avoid_: TypeScript interface, YAML template

**Agent Draft**:
A provenance-marked structured proposal authored through coding-agent reasoning before runtime validation and registration.
_Avoid_: Canonical artifact, runtime output

**Canonical Artifact**:
A validated, normalized, immutable artifact registered by the QA Runtime in a **Run Artifact Manifest**.
_Avoid_: Agent draft, Markdown projection

**Execution Provenance**:
The recorded basis on which the QA Runtime accepts a test result as observed rather than merely asserted.
_Avoid_: Result origin, test source, artifact provenance

**Runtime-Observed Execution**:
A test result produced by a runner process the QA Runtime itself started and whose exit status and output it captured.
_Avoid_: External result, imported result, adapter result

**Reviewed Test Suite**:
A committed collection of executable test files authored outside the **Test DSL**, whose commit identity is the evidence that a human accepted them.
_Avoid_: External tests, imported suite, legacy tests

**Human Attestation**:
An identified person's immutable signed claim that an evaluation no machine performed was actually carried out.
_Avoid_: Manual test result, sign-off, approval decision

**Artifact Version**:
The artifact-type-specific semantic version that identifies the contract used by one canonical artifact.
_Avoid_: Runtime version, product version

**Artifact Projection**:
A human-readable document generated from canonical artifacts without becoming a source of truth.
_Avoid_: Artifact, report data

**Artifact Locale**:
The presentation language of a human-readable **Artifact Projection**, independent of canonical machine fields and values.
_Avoid_: Agent language, schema version

**Skill Bundle**:
The canonical standards-compatible collection of **Skill Adapters** and their progressively disclosed resources.
_Avoid_: Agent plugin, vendor skill pack

**Skill Installation**:
A checksummed copy of a **Skill Bundle** placed in an agent's supported discovery root.
_Avoid_: Skill source, symlink

**Runtime Binding**:
The resolved local QA Runtime executable and compatible version recorded for a **Skill Installation**.
_Avoid_: Remote npx fallback, latest package

**Installation Drift**:
A missing, modified, or unexpected file that makes a **Skill Installation** differ from its recorded manifest.
_Avoid_: Skill update, invalid source bundle

**Test Resource**:
A traceable data resource created for a **QA Run** and owned exclusively by that run.
_Avoid_: Fixture definition, pre-existing data

**Cleanup Run**:
An immutable maintenance **QA Run** that retries cleanup for resources left by a source run.
_Avoid_: Artifact deletion, reopened run

**Reproduction Set**:
The ordered collection of independent **Test Attempts** used to characterize whether one observed product defect recurs.
_Avoid_: Retry count, test rerun

**Product Bug**:
An immutable report of an authoritative product-behavior mismatch supported by one or more failing **Test Attempts**.
_Avoid_: Failed test, test defect

**Bug Candidate**:
A runtime-generated defect proposal derived from an eligible failed attempt before impact triage is complete.
_Avoid_: Product bug, exploratory finding

**Bug Triage State**:
The readiness of a bug report for impact classification: needs triage or triaged.
_Avoid_: Bug status, retest verdict

**Bug Fingerprint**:
A normalized signature used to identify likely duplicate observations without asserting a shared root cause.
_Avoid_: Bug ID, deduplication key

**Defect Severity**:
The QA-owned impact classification of a **Product Bug** from Blocker through Trivial.
_Avoid_: Priority, testcase importance

**Defect Priority Recommendation**:
QA's proposed remediation urgency for a **Product Bug**, subject to product-owner assignment.
_Avoid_: Severity, assigned priority

**Test Priority**:
The execution importance of a **Test Case** within risk-based planning.
_Avoid_: Defect severity, defect priority

**Release Gate**:
A deterministic policy evaluation that produces a release recommendation from validated QA artifacts and configured obligations.
_Avoid_: QA opinion, report summary

**Release Override**:
An authorized decision to proceed contrary to a **Release Gate** without altering its original verdict or evidence.
_Avoid_: Edited recommendation, accepted bug

**Coverage Profile**:
The declared roles, behaviors, platforms, viewports, and risk rules that bound required coverage for a **QA Run**.
_Avoid_: Test suite, browser matrix

**Coverage Obligation**:
A uniquely identified combination of requirement and coverage dimensions that the run must satisfy or explicitly leave out of scope.
_Avoid_: Test count, testcase

**Regression Selection**:
The explainable set of test case revisions chosen to evaluate a declared change scope.
_Avoid_: Regression suite, related tests

**Unmapped Change Risk**:
A changed product or code surface that cannot be traced confidently to requirements, coverage obligations, or test cases.
_Avoid_: Untested code, excluded test

**Exploration Charter**:
The bounded mission, scope, heuristics, safety rules, budget, and stop conditions for one exploratory **QA Run**.
_Avoid_: Test plan, prompt

**Exploratory Finding**:
An evidence-backed observation discovered under an **Exploration Charter** that lacks enough authoritative expectation to be a product bug or decisive test result.
_Avoid_: Failed test, product bug

**Retest Verdict**:
The conclusion about whether one linked **Product Bug** remains observable under a new reproduction set.
_Avoid_: Regression outcome, release recommendation

**Regression Outcome**:
The aggregate execution result of the **Regression Selection** associated with a change or retest.
_Avoid_: Retest verdict, bug status

**Test DSL**:
The bounded structured language of browser actions, locators, and assertions that the **Runtime Browser Driver** can execute deterministically.
_Avoid_: Test instruction, Playwright script

**Test Case Candidate**:
A proposed test definition that has not yet satisfied the rules required to become an executable **Test Case Revision**.
_Avoid_: Test case revision, exploratory finding

**Approval Policy**:
The declared rules that determine whether a **Test Case Candidate** requires human review or may be promoted safely to an executable revision.
_Avoid_: Execution mode, safety profile

**External Effect Permit**:
A time-bound, environment-specific authorization for a narrowly scoped external side effect against designated test targets.
_Avoid_: User consent, allow-external flag

**Test Data Hook**:
A trusted, pre-registered project capability that creates or cleans traceable **Test Resources** through a typed contract.
_Avoid_: Generated shell command, setup step

**Sanitized Raw Evidence**:
An evidence artifact captured after mandatory redaction but before annotation or presentation overlays.
_Avoid_: Unmodified screenshot, unredacted evidence

**Evidence Gap**:
An explicit record that required evidence could not be captured or persisted safely, including its reason and affected claim.
_Avoid_: Missing file, ignored capture

**Evidence Policy**:
The layered rules governing which evidence must, may, or must not be captured for a run and environment.
_Avoid_: Screenshot options, artifact profile

**Browser Evidence Session**:
A live browser observation window in which evidence listeners are registered before the actions they must capture.
_Avoid_: Browser history, retroactive capture

**Browser Attempt Context**:
An isolated browser context owned by exactly one **Test Attempt**, with declared device and session inputs.
_Avoid_: Browser process, shared page

**Capture Geometry**:
The recorded transform between browser CSS page coordinates and the pixels of one captured evidence image.
_Avoid_: Bounding box, guessed coordinates

**Step Result**:
The immutable outcome and evidence of one declared action-and-assertion unit in a **Test Attempt**.
_Avoid_: Test attempt, log line

**Telemetry Finding**:
A console or network observation captured during a **Browser Evidence Session** that does not affect test status unless a declared assertion or policy evaluates it.
_Avoid_: Failed assertion, product bug

**Accessibility Obligation**:
A **Coverage Obligation** that names the required accessibility method rather than treating automated checks as complete accessibility coverage.
_Avoid_: Axe scan, accessibility testcase

**Browser Matrix**:
The browser engines and emulated device profiles required by a **Coverage Profile** for a specific run.
_Avoid_: Cross-browser claim, installed browsers

**Execution Surface**:
The class of product interface that a runtime executor can test and claim coverage for.
_Avoid_: Test type, affected area

**Run Identity**:
A globally unique, UTC-sortable identifier assigned once to a **QA Run** and preserved by all linked artifacts.
_Avoid_: Folder timestamp, sequence number

**Run Outcome**:
The terminal operational state of a **QA Run**, distinct from testcase verdicts and release readiness.
_Avoid_: Release recommendation, test status

**Artifact Profile**:
The versioned set of required and conditional artifact contracts for one workflow mode or standalone operation.
_Avoid_: Output folder template, global checklist

## Relationships

- **QA Skills** contains one **QA Runtime**, one CLI, one **Skill Bundle**, and their shared artifact contracts
- **QA Tester** orchestrates one or more **QA Operations** but does not implement them
- A **Skill Adapter** delegates deterministic QA operations to exactly one **QA Runtime**
- The **QA Runtime** can serve multiple agent-specific **Skill Adapters**
- The **QA Runtime** controls the **Runtime Browser Driver** directly
- An **Agent Browser Adapter** produces the same artifact contract as the **Runtime Browser Driver** without being controlled by the **QA Runtime**
- Every test result carries exactly one **Execution Provenance**
- Only a **Runtime Browser Driver** execution or a **Runtime-Observed Execution** may satisfy a **Coverage Obligation**
- A test result supplied as an **Agent Draft** is reportable but never satisfies a **Coverage Obligation**, regardless of the evidence attached to it
- An **Agent Browser Adapter** result is an **Agent Draft** unless the **QA Runtime** itself started and observed the run that produced it
- A **Runtime-Observed Execution** runs exactly one **Reviewed Test Suite** and records its commit identity
- A **Reviewed Test Suite** whose working tree differs from its recorded commit produces no **Runtime-Observed Execution**
- Agent reasoning may propose a change to a **Reviewed Test Suite** but never executes one it authored in the same run
- A **QA Run** contains zero or more **Test Attempts**
- A retest or regression **QA Run** references its source run without changing the source
- A **Test Attempt** belongs to exactly one **QA Run** and exactly one test case
- An executed test case has one **Execution Status** and one **Failure Classification**
- A test case with `NOT_RUN` has no **Test Attempt**
- Only a `FAILED` **Execution Status** with a `PRODUCT_DEFECT` **Failure Classification** is automatically eligible for a product bug report
- A test or environment classification produces a **Test Incident** or **Environment Incident** rather than a product bug
- An undetermined classification produces an **Investigation Finding** and no inferred root-cause report
- Every decisive expected result references at least one **Requirement Statement**
- Only an `AUTHORITATIVE` **Requirement Authority** can support a `PASSED` or `FAILED` conclusion
- An inferred, assumed, or conflicting **Requirement Statement** can support an observation but not a decisive test conclusion
- An explicit user-provided expected behavior is authoritative for its run unless marked tentative, exploratory, or conflicting with another authoritative source
- A **Test Case** has one stable logical identifier and one or more **Test Case Revisions**
- A **Test Case Revision** expands into one or more **Test Case Instances** without duplicating its logical identity
- A **Test Attempt** references exactly one **Test Case Revision** and preserves its input snapshot
- A **Test Attempt** executes exactly one **Test Case Instance**
- A product bug references the failing **Test Attempt**, not only the logical **Test Case**
- Every executed **Test Attempt** is substantiated by **Evidence Items** bound either to that attempt or to the **Runtime-Observed Execution** that produced it
- The required **Evidence Items** depend on the claim being substantiated rather than on a universal screenshot rule
- Every **Evidence Item** belongs to one **Evidence Manifest** and carries a content checksum
- Every registered artifact belongs to one **Run Artifact Manifest** and is resolved by artifact reference rather than a hard-coded path
- A **Full QA Lifecycle** includes requirement analysis and test-data control even when no data resource must be created
- Every **QA Run** references exactly one **Environment Profile**
- Every executable test step has one **Side-effect Class**
- A production **Environment Profile** permits only `none` **Side-effect Class** steps under an explicit read-only opt-in
- Test inputs and snapshots may contain **Secret References** but never resolved secret values
- A missing **Secret Reference** resolution blocks the affected **Test Attempt** without copying the secret into prompts or artifacts
- A **Run Workspace** belongs to exactly one **QA Run** and accepts writes only while that run is active
- Each **QA Operation** consumes explicit typed inputs and registers typed outputs in the **Run Workspace**
- A **Skill Adapter** and the orchestrator invoke the same **QA Operations**
- Every **Skill Adapter** declares one **Execution Kind**, preventing the CLI from pretending to execute agent-only reasoning
- Every machine-readable QA artifact conforms to one versioned **Artifact Contract**
- An **Agent Draft** becomes a **Canonical Artifact** only after contract, authority, safety, and relationship validation
- The QA Runtime never invokes an LLM to create or repair an **Agent Draft**
- Every canonical artifact records its **Artifact Version** and producing QA Skills version
- A Markdown report or matrix is an **Artifact Projection** generated from canonical JSON
- An **Artifact Locale** may change generated Markdown but never canonical JSON or contract enums
- One **Skill Bundle** serves Codex, Claude Code, and Cursor without duplicated skill definitions
- A **Skill Installation** is derived from the **Skill Bundle** and tracked by an installation manifest
- A **Skill Installation** invokes only its compatible local **Runtime Binding** and never downloads an executable during QA execution
- An **Installation Drift** is reported before update or uninstall and is preserved unless the user explicitly authorizes overwrite
- A **Test Resource** belongs to exactly one creating **QA Run** and may only be removed through its explicit idempotent cleanup action
- A cleanup failure does not change a **Test Attempt**, but it prevents a clean run completion
- A **Cleanup Run** references one terminal source run and never changes that source run's artifacts or outcome
- A **Cleanup Run** changes only owned external **Test Resources** and never deletes source-run artifacts
- A **Reproduction Set** normally contains two total attempts, including the original failing attempt
- An unsafe repetition is omitted from the **Reproduction Set** with an explicit reason rather than executed automatically
- Whole-test reruns always create new **Test Attempts**; a later pass never replaces an earlier failure
- A **Product Bug** has a run-scoped globally unique identifier and references its supporting **Test Attempts**
- Every eligible product failure produces a **Bug Candidate**, which becomes a **Product Bug** report with an explicit **Bug Triage State**
- Only a triaged bug has one of the five canonical **Defect Severity** values
- Matching **Bug Fingerprints** merge observations only within one **QA Run** and produce possible-duplicate hints across runs
- Every **Product Bug** has one evidence-backed **Defect Severity** and may have one **Defect Priority Recommendation**
- A **Test Priority** neither determines nor implies the severity of a discovered bug
- One report evaluates one **Release Gate** and preserves every rule input and verdict
- A **Release Override** references, but never replaces, its **Release Gate** verdict
- A **Coverage Profile** produces zero or more required **Coverage Obligations**
- A **Test Case Revision** may address multiple **Coverage Obligations**
- A **Coverage Obligation** is satisfied only by a qualifying passed **Test Attempt** against an authoritative expectation
- Every member of a **Regression Selection** carries a source, reason, and confidence
- An **Unmapped Change Risk** prevents a claim of complete regression coverage
- An exploratory **QA Run** follows exactly one **Exploration Charter**
- An exploratory **QA Run** reaches the product only through an **Agent Browser Adapter**, never through the **Runtime Browser Driver**
- An **Exploratory Finding** is an **Agent Draft**, so it may propose a requirement or test case candidate but satisfies no **Coverage Obligation**
- A retest **QA Run** produces one **Retest Verdict** for each target **Product Bug**
- A **Regression Outcome** may affect the **Release Gate** without changing the **Retest Verdict** for the original bug
- The **Runtime Browser Driver** executes only validated **Test Case Revisions** expressed in the **Test DSL**
- Natural-language instructions may produce a **Test Case Candidate** but are never executed directly by the **QA Runtime**
- An **Approval Policy** governs every promotion from **Test Case Candidate** to **Test Case Revision**
- Production candidates always require human approval regardless of the configured **Approval Policy**
- An `external` **Side-effect Class** step requires a matching **External Effect Permit** before execution
- An **External Effect Permit** authorizes no destructive action, real payment, wildcard recipient, or unspecified environment
- The test-data manager provisions or cleans resources only through configured **Test Data Hooks**
- A **Test Data Hook** returns explicit resource ownership and cleanup metadata and is never authored during QA execution
- Protected environments persist only **Sanitized Raw Evidence**, from which annotated derivatives are generated
- An unsafe or failed redaction produces an **Evidence Gap** instead of an unredacted artifact
- An **Evidence Policy** is bounded first by environment safety, then by artifact-profile minimums, run settings, and testcase requests
- A testcase may increase evidence capture within the safety boundary but never weaken required evidence
- A **Browser Evidence Session** archive is retained only when the **Environment Profile** permits it, no secret has been resolved, and no redaction target is declared
- Declaring any redaction target makes the environment protected, because no archive channel can prove that target was masked
- A refused archive produces an **Evidence Gap**, never a silently omitted capture
- A **Browser Evidence Session** may be created independently or attached to an active runtime browser session
- Console and network **Evidence Items** can substantiate only events observed after their **Browser Evidence Session** began
- Every browser **Test Attempt** owns a fresh **Browser Attempt Context**
- A browser process may host multiple sequential **Browser Attempt Contexts**, but no state is shared between them
- Every screenshot **Evidence Item** records **Capture Geometry** before annotations are rendered
- An annotated screenshot is derived from immutable raw evidence using validated pixel boxes normalized through **Capture Geometry**
- A **Test Attempt** contains an ordered sequence of **Step Results** and stops on the first failure by default
- An attempt verdict is derived deterministically from its **Step Results**, and `PASSED` requires every mandatory assertion to be verified
- Every observed console error and failed request becomes a **Telemetry Finding** unless classified as a normal browser cancellation
- A **Telemetry Finding** changes an **Execution Status** only through an explicit testcase assertion or coverage policy
- An **Accessibility Obligation** distinguishes automated analysis, keyboard evaluation, screen-reader evaluation, and cognitive/manual review
- An automated **Accessibility Obligation** is satisfied only by a machine-produced artifact, and a manual one only by a **Human Attestation**
- A declared evaluation method never satisfies an **Accessibility Obligation** by matching its own label
- A **Browser Matrix** may require Chromium, Firefox, WebKit, and declared emulated devices independently
- Missing execution for one required **Browser Matrix** member is never satisfied by another engine or viewport
- A **Browser Matrix** member is credited from the engine the **QA Runtime** observed, never from the engine a test case declared
- Every **Coverage Obligation** declares exactly one **Execution Surface**
- The **QA Runtime** executes the browser **Execution Surface** itself and reaches every other surface only through a **Runtime-Observed Execution**
- An **Execution Surface** that no executor covers still produces authorable obligations, which remain explicitly unmet rather than absent
- Every **QA Run** has one immutable **Run Identity** formed from a UTC timestamp and random suffix
- Attempts and evidence use time-sortable globally unique IDs without shared counters
- A **Run Outcome** is assigned only after final artifact validation
- A run may resume only before its **Run Outcome** is assigned and never overwrites a completed operation artifact
- Every **QA Run** is finalized against exactly one **Artifact Profile**
- An **Evidence Gap** may satisfy an **Artifact Profile** structurally while still leaving coverage or release gates unmet

## Example dialogue

> **Dev:** “Should the browser execution logic live in each agent's skill file?”
> **Domain expert:** “No. The **Skill Adapter** explains how the agent invokes the capability; the **QA Runtime** owns the executable behavior.”
>
> **Dev:** “Should a successful retest replace the failed result?”
> **Domain expert:** “No. Create a new **QA Run** and preserve both **Test Attempts** so the defect history remains auditable.”
>
> **Dev:** “The locator is broken, so is the feature test failed?”
> **Domain expert:** “No. Record `BLOCKED` as the **Execution Status** and `TEST_DEFECT` as the **Failure Classification**.”
>
> **Dev:** “If it is not a product bug, can the report omit it?”
> **Domain expert:** “No. Preserve a **Test Incident**, **Environment Incident**, or **Investigation Finding** with its coverage impact.”
>
> **Dev:** “The current UI behaves this way. Can that become the expected result?”
> **Domain expert:** “Only as an inferred **Requirement Statement**. It cannot produce a decisive pass or fail until its **Requirement Authority** is authoritative.”
>
> **Dev:** “We clarified an expected result. Should we create a new test case ID?”
> **Domain expert:** “Keep the **Test Case** ID if the testing intent is unchanged, but produce a new **Test Case Revision**.”
>
> **Dev:** “Should desktop and mobile copies get separate testcase IDs?”
> **Domain expert:** “No. If intent and assertions match, expand the revision into distinct **Test Case Instances**.”
>
> **Dev:** “A dependency prevented the browser from opening. Should we create an annotated screenshot?”
> **Domain expert:** “No. Attach an **Evidence Item** that proves the blocker; never fabricate an irrelevant screenshot.”
>
> **Dev:** “Can a report generator assume results live at `execution-result.json`?”
> **Domain expert:** “No. Resolve typed inputs through the **Run Artifact Manifest**; the directory layout is for people.”
>
> **Dev:** “Can we call it a full run if we start from generated testcases and ignore their requirement sources?”
> **Domain expert:** “No. A **Full QA Lifecycle** must establish requirement authority before execution.”
>
> **Dev:** “The production form submission can be undone later. May the run execute it?”
> **Domain expert:** “No. Production is limited to an explicitly enabled read-only run, so only steps with a `none` **Side-effect Class** are eligible.”
>
> **Dev:** “Should the testcase snapshot record the password used during execution?”
> **Domain expert:** “No. Preserve only the **Secret Reference**; resolve its value in memory and scrub it from all evidence.”
>
> **Dev:** “Can the report generator scan for whichever result file looks newest?”
> **Domain expert:** “No. A **QA Operation** consumes registered inputs from one **Run Workspace**; it never guesses from directory contents.”
>
> **Dev:** “Can `qa-skill run` analyze requirements without a model provider?”
> **Domain expert:** “No. Its **Execution Kind** is agent-authored: an agent creates the draft and the runtime ingests it.”
>
> **Dev:** “Should we fix a report by editing its Markdown?”
> **Domain expert:** “No. Fix the canonical JSON or its **Artifact Contract**, then regenerate the **Artifact Projection**.”
>
> **Dev:** “Does the CLI call an LLM to design testcases?”
> **Domain expert:** “No. The coding agent creates an **Agent Draft**; the runtime either registers a valid **Canonical Artifact** or rejects it.”
>
> **Dev:** “Should a Vietnamese report translate `FAILED` inside JSON?”
> **Domain expert:** “No. **Artifact Locale** affects only the human-readable projection; machine values remain canonical English.”
>
> **Dev:** “Can a newer runtime silently rewrite an old run into its current schema?”
> **Domain expert:** “No. Preserve the original **Artifact Version**; any future migration produces a new linked artifact.”
>
> **Dev:** “Should we patch the Cursor copy of a skill directly?”
> **Domain expert:** “No. Change the canonical **Skill Bundle** and refresh the tracked **Skill Installation**.”
>
> **Dev:** “Can the skill download the latest CLI when its runtime is missing?”
> **Domain expert:** “No. Resolve a pinned local **Runtime Binding** or stop with setup guidance.”
>
> **Dev:** “Can update overwrite a locally edited installed skill?”
> **Domain expert:** “Not silently. Report the **Installation Drift** and require explicit force before replacing it.”
>
> **Dev:** “Cleanup failed after a passed test. Should the test become failed?”
> **Domain expert:** “No. Preserve the **Test Attempt**, mark the run completion failure, and use a linked **Cleanup Run** to retry the owned **Test Resources**.”
>
> **Dev:** “After the first failure, do we rerun twice to claim `2/2`?”
> **Domain expert:** “No. The original failure is the first member of the **Reproduction Set**; one independent confirmation produces two total attempts.”
>
> **Dev:** “Two runs show the same validation message. Are they definitely the same bug?”
> **Domain expert:** “No. A matching **Bug Fingerprint** is a possible-duplicate signal; only observations within one run are automatically consolidated.”
>
> **Dev:** “Business impact is unclear. Should the agent choose Major?”
> **Domain expert:** “No. Preserve the **Bug Candidate** as `NEEDS_TRIAGE`; only a triaged report receives a canonical severity.”
>
> **Dev:** “A critical-priority testcase failed. Is the bug automatically Critical?”
> **Domain expert:** “No. **Test Priority** schedules coverage; assess **Defect Severity** from impact and make a separate **Defect Priority Recommendation**.”
>
> **Dev:** “Can the report writer call this build ready because the remaining gaps look harmless?”
> **Domain expert:** “No. The **Release Gate** computes the recommendation; an authorized **Release Override** can document a different business decision.”
>
> **Dev:** “We ran many desktop tests. Is responsive coverage complete?”
> **Domain expert:** “Only if every required responsive **Coverage Obligation** in the **Coverage Profile** is satisfied.”
>
> **Dev:** “The agent thinks this testcase is unrelated. Can regression skip it?”
> **Domain expert:** “Only with an explicit exclusion rationale; uncertain mappings remain visible as an **Unmapped Change Risk**.”
>
> **Dev:** “Exploration found surprising behavior. Is that automatically a failed test?”
> **Domain expert:** “No. Without an authoritative expected result it is an **Exploratory Finding**, which may propose a requirement or test candidate for review.”
>
> **Dev:** “The original bug is gone, but an adjacent workflow now fails. Is the retest `NOT_FIXED`?”
> **Domain expert:** “No. Record `FIXED` as the **Retest Verdict**, the new failure in the **Regression Outcome**, and let the **Release Gate** assess the build.”
>
> **Dev:** “Can the runtime interpret ‘test that registration works’ while controlling Playwright?”
> **Domain expert:** “No. The agent may translate that instruction into a **Test Case Candidate**; the runtime executes only a validated **Test DSL** revision.”
>
> **Dev:** “Can full mode immediately run every generated candidate?”
> **Domain expert:** “No. Its **Approval Policy** may auto-promote only authoritative, schema-valid, non-production candidates whose side effects and cleanup are safe.”
>
> **Dev:** “The user said external calls are okay. Can we send to any address in staging?”
> **Domain expert:** “No. An **External Effect Permit** must name the channel, test target, environment, usage limit, and expiry.”
>
> **Dev:** “Can the agent improvise a database deletion command for cleanup?”
> **Domain expert:** “No. It may invoke only a configured **Test Data Hook** whose typed result identifies resources owned by the run.”
>
> **Dev:** “Does raw evidence preserve the original production pixels?”
> **Domain expert:** “No. It is **Sanitized Raw Evidence**: unannotated but already redacted. If safe capture is impossible, record an **Evidence Gap**.”
>
> **Dev:** “Can a testcase turn off failure screenshots required by the run profile?”
> **Domain expert:** “No. Its **Evidence Policy** may request more capture, while safety ceilings and profile minimums retain precedence.”
>
> **Dev:** “Can evidence collection recover the failed request from a browser session that already closed?”
> **Domain expert:** “No. Start or attach a **Browser Evidence Session** before reproduction; otherwise record an **Evidence Gap**.”
>
> **Dev:** “Can the next testcase reuse the logged-in page from the previous one?”
> **Domain expert:** “No. Give it a new **Browser Attempt Context** and load only the session state declared by its test revision.”
>
> **Dev:** “Can the agent estimate where to draw the error marker?”
> **Domain expert:** “No. Record the DOM box and **Capture Geometry**, normalize it to image pixels, and reject invalid transforms.”
>
> **Dev:** “An early action was blocked. Can later dependent steps still count as passed?”
> **Domain expert:** “No. Record the action's **Step Result** as blocked and dependent steps as not run; do not infer their outcomes.”
>
> **Dev:** “A third-party script logged an error while the expected UI still passed. Does the testcase fail?”
> **Domain expert:** “Only if a declared assertion or policy evaluates that **Telemetry Finding**; otherwise preserve it as reportable risk evidence.”
>
> **Dev:** “Axe reported no violations. Is accessibility covered?”
> **Domain expert:** “Only the automated **Accessibility Obligations** are satisfied; keyboard and manual methods retain their own explicit outcomes.”
>
> **Dev:** “Chromium desktop and mobile viewport passed. Is cross-browser coverage complete?”
> **Domain expert:** “Only if those are the complete declared **Browser Matrix**; viewport emulation is not another browser engine or a real device.”
>
> **Dev:** “The browser observed a successful API response. Does that satisfy an API-only obligation?”
> **Domain expert:** “No. It is browser evidence; the MVP's **Execution Surface** does not include an API-only executor.”
>
> **Dev:** “Can two agents started in the same second share a run folder?”
> **Domain expert:** “No. Each receives a random-suffixed **Run Identity**, and all machine timestamps remain UTC.”
>
> **Dev:** “A run produced valid evidence for a product failure. Is the run itself aborted?”
> **Domain expert:** “No. Its **Run Outcome** is completed with failures; aborted is reserved for cancellation or an invalid/unrecoverable run.”
>
> **Dev:** “Should a plan-only run fail validation because it has no screenshots?”
> **Domain expert:** “No. Validate it against its planning **Artifact Profile**, not the full-execution profile.”

## Flagged ambiguities

- “qa-tester” could name the entire system or its entry-point skill — resolved: **QA Skills** is the system and **QA Tester** is only the orchestrator skill.
- “Skill” was used for both agent instructions and executable QA behavior — resolved: **Skill Adapter** is agent-facing, while **QA Runtime** is the executable source of truth.
- “Browser driver” was used for both runtime-controlled Playwright and agent-owned browser tools — resolved: only Playwright is the **Runtime Browser Driver**; built-in and MCP tools use an **Agent Browser Adapter**.
- “Produces the same artifact contract” could imply that an **Agent Browser Adapter** result satisfies coverage — resolved: contract conformance and coverage credit are separate concerns, and only a **Runtime Browser Driver** execution or a **Runtime-Observed Execution** credits a **Coverage Obligation**.
- “Who ran the test” was treated as the trust anchor for a result — resolved: the anchor is **Execution Provenance**, which records whether the **QA Runtime** *observed* the run, not whether it *drove the browser*.
- An **Evidence Item** was assumed to substantiate exactly one **Test Attempt** — resolved: it binds to one attempt or to one **Runtime-Observed Execution**, so many attempts may share the runner output that substantiates them.
- “Production-ready” could describe either QA Skills itself or the product it evaluates — resolved: **Product Readiness** describes QA Skills, while a **Release Gate** owns the **Release Recommendation** for the system under test.
- “Retest” could imply updating an earlier result — resolved: retest and regression create new linked **QA Runs** and never overwrite prior evidence.
- “Failed test” mixed the observed outcome with its cause — resolved: **Execution Status** and **Failure Classification** are separate concepts.
- “Bug report” could absorb every non-passing outcome — resolved: only product defects become bugs; test/environment defects and unknown causes have distinct incident/finding artifacts.
- “Requirement” included both approved behavior and agent assumptions — resolved: every **Requirement Statement** carries an explicit **Requirement Authority**.
- User prompt text could be treated uniformly as authoritative — resolved: only explicit expected behavior is authoritative for the run; tentative, exploratory, and conflicting statements retain non-decisive authority.
- “Testcase ID” could not distinguish stable intent from changed content — resolved: **Test Case** identity is stable while each content change creates a **Test Case Revision**.
- Repeated data/browser variants could inflate testcase counts — resolved: one revision expands into traceable **Test Case Instances**, while materially different behavior gets a new testcase.
- “Evidence” could mean any attached file — resolved: an **Evidence Item** must substantiate a claim and be registered with provenance in an **Evidence Manifest**.
- Stable output folders could be mistaken for the machine contract — resolved: the **Run Artifact Manifest** is authoritative and paths are referenced, checksummed data.
- The MVP list omitted requirement analysis and test-data management while requiring a full workflow — resolved: both are part of the **Full QA Lifecycle** and the MVP.
- “Non-destructive production test” could still mutate or expose real data — resolved: production requires an explicit read-only opt-in, redacted evidence, and `none` **Side-effect Class** steps only.
- “Test data” could include credentials — resolved: credentials and browser sessions are external **Secret References**, never QA artifacts.
- “Independent skill” could imply a separate implementation or implicit filesystem discovery — resolved: every skill invokes a shared typed **QA Operation** within a **Run Workspace**.
- “Run a skill” could imply every skill is executable by the CLI — resolved: **Execution Kind** distinguishes agent-authored, runtime-backed, and hybrid capabilities.
- JSON, YAML, TypeScript, and Markdown were all potential data authorities — resolved: versioned JSON Schema defines the **Artifact Contract**, canonical artifacts are JSON, and Markdown is an **Artifact Projection**.
- Runtime-centric architecture could imply embedding a model provider — resolved: coding agents author **Agent Drafts**, while the model-independent runtime validates and registers **Canonical Artifacts**.
- Report language could alter machine-readable values — resolved: **Artifact Locale** affects projections only, while canonical contracts remain English.
- Product releases and artifact schemas could share one version implicitly — resolved: each artifact has its own **Artifact Version** plus the producer's QA Skills version.
- “Cross-agent support” could imply three maintained skill copies — resolved: one **Skill Bundle** is copied into agent-specific roots as tracked **Skill Installations**.
- “Invoke the runtime” could imply downloading the latest npm package — resolved: every installation uses a compatible local **Runtime Binding** and fails closed when absent.
- “Installed skill” could be assumed identical to its source — resolved: checksums detect **Installation Drift**, which update and uninstall preserve by default.
- “Cleanup retry” could imply reopening a terminal run — resolved: it creates a linked **Cleanup Run** and leaves the source immutable.
- CLI “cleanup” could mean deleting results or cleaning test data — resolved: it affects only owned external **Test Resources**; artifact retention is a separate concern.
- “Reproduce twice” conflicted with the `2/2` report template — resolved: a normal **Reproduction Set** contains two total attempts, including the original failure.
- Automatic retries could hide intermittent behavior — resolved: only locator/assertion polling is implicit; every whole-test rerun is a preserved **Test Attempt**.
- Sequential feature-only bug IDs could collide across runs — resolved: **Product Bug** IDs include a run suffix, while **Bug Fingerprints** support conservative duplicate hints.
- Required severity values could force unsupported guesses — resolved: a **Bug Triage State** permits `NEEDS_TRIAGE` without inventing a severity.
- “Priority” could mean testcase importance, defect impact, or remediation urgency — resolved: **Test Priority**, **Defect Severity**, and **Defect Priority Recommendation** are distinct.
- “Release recommendation” could be a subjective agent conclusion — resolved: a deterministic **Release Gate** owns the verdict, while AI may only explain it.
- “Full coverage” could mean a large testcase count or every possible combination — resolved: it means satisfying every required **Coverage Obligation** within the declared **Coverage Profile**.
- “Related regression tests” could be an opaque agent guess — resolved: a **Regression Selection** is traceable and confidence-scored, with **Unmapped Change Risks** reported explicitly.
- “Exploratory test” could silently invent expected behavior — resolved: an **Exploration Charter** yields observations and candidates, while only authoritative mismatches become product bugs.
- “Retest passed” could hide adjacent regressions or conflate them with the original defect — resolved: **Retest Verdict** and **Regression Outcome** are separate conclusions.
- “Executable testcase” could mean natural-language instructions interpreted at runtime — resolved: agent reasoning creates candidates, while the **Runtime Browser Driver** executes only the bounded **Test DSL**.
- “Full workflow” could imply unreviewed execution of every generated case — resolved: an **Approval Policy** controls promotion, with production always requiring human approval.
- “Permission for external side effects” could be broad prompt text — resolved: execution requires a scoped **External Effect Permit**, while real payments and destructive external actions remain prohibited in the MVP.
- “Seed script” could mean arbitrary agent-generated shell code — resolved: execution uses only trusted, pre-registered **Test Data Hooks** with typed resource and cleanup contracts.
- “Raw screenshot” could imply persisted sensitive pixels — resolved: protected targets produce **Sanitized Raw Evidence**, and unsafe capture becomes an explicit **Evidence Gap**.
- “Redact before persisting” was applied only to screenshots while trace archives kept unmasked DOM and network content — resolved: an archive channel that cannot honour a declared redaction target is refused as an **Evidence Gap**, never retained unmasked.
- Multiple evidence settings could silently override one another — resolved: **Evidence Policy** has explicit safety, profile, run, and testcase precedence.
- “Independent evidence collection” could imply retroactive browser telemetry — resolved: console and network evidence require a live **Browser Evidence Session**, while existing screenshots may still be annotated with provenance.
- “Reuse the browser” could mean sharing state between tests — resolved: only the browser process may be reused; every **Test Attempt** gets an isolated **Browser Attempt Context**.
- “Bounding box” lacked a coordinate space — resolved: **Capture Geometry** records the CSS-to-pixel transform and annotation uses validated normalized pixel boxes.
- “Continue after failure” could produce unsafe side effects and misleading downstream results — resolved: attempts fail fast unless later steps explicitly declare safe independence.
- “Console/network error” could be treated as an automatic test failure or ignored noise — resolved: it is a **Telemetry Finding** evaluated only by explicit assertions or policy and always remains reportable.
- “Accessibility coverage” could mean a clean automated scan — resolved: each **Accessibility Obligation** records its evaluation method, and manual methods are never inferred from automation.
- “Mobile” and “cross-browser” could overstate viewport emulation — resolved: the **Browser Matrix** records engines and emulated devices explicitly, with real devices outside the MVP.
- “Software testing” could imply every interface type — resolved: the MVP's executable **Execution Surface** is web browser testing only.
- Timestamp-only run IDs could collide or depend on local timezone — resolved: **Run Identity** combines a UTC timestamp with a random suffix.
- “Run status” could mean test results or release readiness — resolved: **Run Outcome** describes operational completion only and is assigned after validation.
- “Valid test run” could imply one universal file checklist — resolved: each mode or standalone operation has a versioned **Artifact Profile**.
