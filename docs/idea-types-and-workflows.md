# Idea Types And Workflows

Decision date: 2026-06-12

## Decision

`Idea` remains the user-facing container for incoming work. Each idea gets an explicit `Idea type` that determines the expected artifact, agent instructions, gates, and evidence.

Idea type is not a board status. Board statuses remain mapped to fixed internal workflow slots:

`inbox -> planning -> in_progress -> review -> uat -> done`

The idea type changes what each slot means. This lets Twindem support work that is not primarily code implementation, while preserving one board-driven source of truth.

## Idea Types

| Type | Default artifact | Requires implementation | Typical use |
| --- | --- | --- | --- |
| `feature` | Implementation | Yes | New product behavior, UI, integration, automation, workflow change |
| `bug` | Fix | Yes | Defect repair, regression, broken flow, incorrect behavior |
| `spike` | Prototype / feasibility proof | No | Time-boxed technical exploration, proof of concept, feasibility validation |
| `architecture` | ADR / technical decision | No | Project foundations, stack choice, cloud architecture, service boundaries, security posture |
| `research` | Findings + recommendation | No | Comparison, feasibility check, spike, discovery without guaranteed code |
| `runbook` | Procedure / checklist | No | Release process, deployment procedure, incident process, operational playbook |

## Workflow Meaning By Type

| Type | `planning` | `in_progress` | `review` | `uat` | `done` |
| --- | --- | --- | --- | --- | --- |
| `feature` | Technical plan + acceptance criteria | Implementation | Code review by Agent 2 | User validation / UAT | Released or accepted |
| `bug` | Reproduction + root cause | Fix | Regression review by Agent 2 | Verify bug fix | Confirmed fixed |
| `spike` | Question, scope, experiment plan | Prototype / feasibility proof | Evidence review | Decision checkpoint | Spike accepted |
| `architecture` | Options, constraints, risks, ADR outline | Decision document / optional proof of concept | Challenge assumptions, risks, lock-in, cost, migration path | Human/stakeholder approval | ADR accepted |
| `research` | Research questions + scope | Investigation / comparison / spike | Critique findings and recommendation | Decision checkpoint | Recommendation accepted |
| `runbook` | Scope, preconditions, rollback concerns | Draft procedure | Safety/reliability review | Dry-run or validation | Runbook approved |

## Product Behavior

- `New idea` should include an `Idea type` selector:
  - `Feature`
  - `Bug`
  - `Spike`
  - `Architecture`
  - `Research`
  - `Runbook`
- `Feature` and `Bug` default to implementation-oriented prompts.
- `Spike`, `Architecture`, `Research`, and `Runbook` default to reviewed work products rather than production implementation. A spike may include prototype code or proof-of-concept output inside the approved experiment scope.
- `Architecture` follow-up generation may emit `spike` stories when the ADR needs feasibility evidence before implementation.
- A `spike` derived from an ADR must record its conclusions back on the source ADR before it is accepted.
- The selected type should be stored as metadata/label on the board item, not encoded as a status.
- Agent prompts should adapt to the idea type:
  - Agent 1 authors the primary artifact.
  - Agent 2 reviews/challenges it.
  - The human gate approves phase transitions.
- `Architecture` should favor an ADR-style artifact.
- `Research` should favor options, evidence, tradeoffs, and a recommendation.
- `Runbook` should favor repeatable steps, validation, rollback/safety notes, and dry-run evidence.

## Evidence Expectations

| Type | Evidence required before `done` |
| --- | --- |
| `feature` | Implementation summary, tests/checks, review result, acceptance evidence |
| `bug` | Reproduction evidence, root cause, fix summary, regression verification |
| `spike` | Experiment question, prototype or notes, findings, recommendation, ADR conclusion update, decision evidence |
| `architecture` | ADR/proposal, alternatives considered, risks/tradeoffs, Agent 2 challenge, human approval |
| `research` | Sources or observations, comparison matrix, recommendation, open questions, human decision |
| `runbook` | Procedure, prerequisites, validation steps, rollback/safety notes, dry-run or review evidence |

## Rationale

This keeps Twindem aligned with the positioning: `Provable AI delivery.` Twindem should not only coordinate code work; it should make delivery decisions reviewable, auditable, and defensible.

The board remains the source of truth, but the idea type defines what kind of work product and proof are required.
