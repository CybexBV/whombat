# Agent outcomes (AO)

John, 2026-10-04: “Implement your suggestions”, accepting the six-part Hermes comparison and the five-agent workflow table.

## Scope and delivery

- AO-01: Extend the existing runtime, memory, computers and skills. Keep private profiles, the commit pipeline,
  permission keys, approval resumes and per-agent computers. Ship to DEV only.
- AO-02: Complete attachment, binary file, folder and recurring-calendar operations and introduce Microsoft 365
  through provider-neutral connector contracts. Account authorization remains personal; outgoing messages retain
  their existing approval requirement, including the exact attached bytes.
- AO-03: Record preference evidence, confidence and confirmation/expiry; use Unicode-aware multilingual recall.
  Corrections replace old facts, expired facts do not enter prompts, and source access is checked before disclosure.
- AO-04: Attach observed evidence to run completion and delegated results. Do not silently mark unfinished steps
  successful. Keep evidence proportionate to the task and distinguish observation from an agent's claim.
- AO-05: Check skill prerequisites and track skill outcomes across providers; teach practical workflows for all five
  roles, with executable checks and evidence. Retain upstream notices and immutable pack versions.
- AO-06: Admit work using current appliance capacity, including background services. Keep configured concurrency
  as an upper bound; resource pressure postpones work rather than failing the user's task.
- AO-07: Provide repeatable customer-task evaluations covering completion, recovery, recall/correction, privacy,
  interventions and cost. Keep deterministic quick checks separate from opt-in live provider evaluations.

## Implementation checklist

- [x] Contracts and compatibility
- [x] Connector operations and Microsoft 365
- [x] Appliance and skill readiness, resource admission
- [x] Preference provenance, correction and multilingual recall
- [x] Skill outcomes and five-agent workflows
- [x] Completion evidence
- [x] Customer-task evaluations
- [x] App controls and visual verification
- [x] Required quick checks and app/contracts release artifacts
- DEV rollout is recorded in the appliance's candidate 0.41.0 and its agent-outcomes decision.

## Rollout details

- AO-08: Migration 0069 captures existing agent attachments to the five affected bundled packs at their released versions through Developer 1.2.1, Finance 1.1.2 and Lead 1.2.0. Startup upgrades those exact pins to Developer/Lead 1.3.0 and the other three packs 1.2.0 through the commit pipeline, signed by each agent. Removed attachments and intervening pin changes are skipped; disabled packs, skill switches and grants are preserved. The consumed queue prevents later deliberate downgrades from being overridden. Custom and burrow-wide pins stay explicit.
- Profile additions now change the session fingerprint as corrections do. The visible entry set also changes on expiry or source-access loss, preventing old session context from retaining those facts; this trades some prompt-cache reuse for correctness.
- Skill prerequisite declarations are checked by the agent in its actual computer; the Operator workflow includes an executable preflight. Runtime capacity admission is automatic. Skill success is a report backed by observed activity, not a proof of task correctness.
- Microsoft supports delegated mail/calendar/OneDrive/contacts; inline draft attachments are below 3 MiB each. Recurrence supports an explicit RFC5545 subset and refuses unsupported rules. Native Word/Excel editing uses downloaded-file workflows. Real-account consent and live customer-task evaluations remain separate from deterministic tests.

## Verification

Contracts 0.45.1: 1,543 tests; app 0.34.0: 2,278 tests; runtime quick checks: 2,106 tests; real-Postgres server suite: 1,679 tests. Five skill validations and desktop light/dark settings checks passed. Microsoft real-account consent and live customer-task evaluations were not run.
