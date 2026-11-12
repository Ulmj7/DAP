# Implementation Plan: AI Security Foundation

**Branch**: `001-ai-security-foundation` (spec directory id; the repo is not under git, so no branch exists) | **Date**: 2026-11-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ai-security-foundation/spec.md`

## Summary

Build the security boundary that every future AI feature must pass through, and nothing else.
The AI layer can only hand an **untrusted proposal** to a deterministic **Policy Gateway**. The
Gateway resolves the proposal against an immutable, typed **Action Registry**, validates it with
strict runtime schemas, checks the caller's trusted identity, tenant, permissions, resource access,
limits, and replay status through host-implemented ports, demands a **server-verified confirmation**
for dangerous operations, writes a durable **audit** record, and only then lets an **executor** run,
using a single-use grant that nothing else can mint. Every failure, throw, and timeout is a denial.

Technical approach (details in [research.md](./research.md)):

- TypeScript monorepo (npm workspaces). **Package boundaries enforce the layering**: the AI package
  depends only on the contracts package, so it cannot import executors or the Gateway internals.
- Zod 4 `strictObject` schemas, checked at registration through JSON Schema export in `input` mode
  (verified by running it: plain `z.object` silently strips unknown keys).
- PostgreSQL holds all shared security state (confirmations, replay claims, rate counters, audit,
  tenant narrowing) with forced row-level security, atomic single-statement transitions, and the
  database clock, so controls hold across restarts and replicas.
- Authentication and authorization are **host-implemented ports**. This feature builds neither.
- A scripted hostile planner and an attack catalogue of 102 scenarios (plus a 36-case
  dependency-failure matrix and property-based invariants) prove each control with no LLM.

The requested pipeline is preserved: *AI Planner, Action Proposal, Schema Validation, Policy
Gateway, Authorization, Confirmation if required, Action Executor.* Research D6 makes it precise
and explains three ordering choices (trusted context first, cheap shared-state checks early,
durable audit before any execution).

## Technical Context

**Language/Version**: TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on Node.js 22

**Primary Dependencies**: Zod 4 (4.6.7 verified); `pg` (node-postgres, explicit parameterized SQL, no ORM); Fastify (reference host only); `prom-client`; `pino`. Dev: Vitest, fast-check, dependency-cruiser, ESLint with typescript-eslint, Stryker (nightly, optional). Versions other than Zod are pinned by the lockfile at implementation time

**Storage**: PostgreSQL 16 or newer (confirmations, replay claims, rate counters, audit events, tenant action policy) with forced row-level security; in-memory adapter for fast tests

**Testing**: Vitest (unit, contract, conformance, attack suites), fast-check (property tests), real PostgreSQL for shared-state scenarios, dependency-cruiser (architecture)

**Target Platform**: Linux containers (Docker, Docker Compose, Kubernetes validated on Minikube)

**Project Type**: TypeScript library monorepo plus one thin, non-production reference service

**Performance Goals**: No numeric latency or throughput target exists in the spec, so none is invented. Gateway evaluation time is measured (histogram). Design intent: a bounded number of indexed database round trips per proposal, and a local per-turn pre-check so floods cost no database call

**Constraints**: Fail closed everywhere; Gateway decisions deterministic and LLM-free; no general execution capability of any kind (FR-050); all shared state tenant-partitioned and database-clock based; metrics and logs carry no tenant, user, secret, or raw DOM data

**Scale/Scope**: Course-project scale (tens of tenants, hundreds of users) with a design that does not preclude several service replicas. Scope: 6 risk classes, 7 outcome types, 9 audit event types, 5 shared-state tables, 12 registration rules, 102 catalogued attack scenarios plus a 36-case dependency-failure matrix (9 ports x 4 failure modes)

**Existing stack and authentication**: None exists (repo contains documentation only). Nothing is replaced. Authentication and authorization are ports the host application will implement; the reference host ships only a development-only stub that refuses to run in production

**Unknowns**: none remain open in Technical Context. Five spec ambiguities are resolved as **provisional** decisions and tracked below.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated twice: once on the spec and constitution before research, once against the finished
design. Result both times: **PASS, no violations.** Items needing attention are listed after the table.

| # | Principle | Design response | Pre | Post |
|---|-----------|-----------------|-----|------|
| I | LLM is an untrusted planner | AI layer holds only a `ProposalSubmitter` bound to a session. Identity, tenant, run metadata, and `callId` come from trusted code (D5, D11) | PASS | PASS |
| II | LLM output never authorizes | Claims in text or parameters are unknown keys or ignored. Confirmation is a separate door (`ConfirmationService`) the AI layer cannot reach. Tests ATK-CONFIRM-02/03, ATK-PRIV-02 | PASS | PASS |
| III | Deterministic Policy Gateway | Single chokepoint; executors need a single-use grant minted by the Gateway; no LLM in the decision path. Static graph, types, and runtime grant checks (D4, D5) | PASS | PASS |
| IV | Default deny, allowlists | Global allowlist empty by default; exact-match registry; strict schemas; reserved-forbidden list is supplementary only (D3, D6) | PASS | PASS |
| V | AI never receives secrets | The AI layer sees only `PlannerFeedback`; audit records only allowlisted parameters; canary tests on every planner-visible output (D13, D17) | PASS | PASS |
| VI | Sensitive DOM removed client-side | **Out of scope** for this feature by spec. No conflict. Dependency: the planner feature must not ship before the privacy layer exists | n/a | n/a |
| VII | No arbitrary execution | Reserved FORBIDDEN names, no generic execution path, lint bans `eval`/`new Function`, static scan for process, VM, and HTTP-client use (ATK-ARCH-06/10); browser is display-only (D15) | PASS | PASS |
| VIII | Registered typed capabilities | `ActionDefinition` with rules R1-R12 enforced at startup; immutable registry with no mutators | PASS | PASS |
| IX | Backend authorization authoritative | Permissions checked live through host ports; resources resolved server-side; AI-supplied ids are untrusted lookup keys; errors never reach the AI (D7) | PASS | PASS |
| X | No privilege amplification | Context carries the user's own authority into every executor; parity oracle compares AI path to direct path. See attention item 4 | PASS | PASS |
| XI | Tenant isolation | One active tenant per context; every store operation takes a `TenantScope`; forced row-level security; cross-tenant scenarios ATK-XTENANT-01..10 (D8, D9) | PASS | PASS |
| XII | RAG content is untrusted data | **Out of scope** (no RAG here). Prepared by the envelope having no free-text decision channel and by the metamorphic injection test | n/a | n/a |
| XIII | Server-verified confirmation | Server-created, single-use, time-limited, bound to action, parameters, resource, user, and tenant; trusted consequence text; re-authorization on accept (D10) | PASS | PASS |
| XIV | Auditable state changes | Nine event types; durable allow-event before any execution; allowlist parameter projection; append-only table (D13) | PASS | PASS |
| XV | Survives full LLM compromise | Controls live outside the model; hostile-planner tests run without any LLM; limits enforced server-side (D12, D17) | PASS | PASS |
| XVI | Least privilege, strict schemas, minimal context, fail closed | Every port wrapped with timeout and shape check; any failure denies; the AI sees a closed-set category only (D14) | PASS | PASS |
| XVII | Security tests mandatory | Catalogue plus coverage gate that fails CI on any uncovered, unwaived scenario (FR-048) | PASS | PASS |

**Workflow gates (constitution Section 3)**: feature branches and pull-request review, CI on every
push and pull request, Arrange-Act-Assert tests with mocks for external ports, linter and
dependency scanning in CI, secret scanning, AI-assistance disclosure, Docker with cache-ordered
layers, Kubernetes manifests on Minikube, Prometheus and Grafana with security metrics, DORA
metrics and retrospectives. All are planned in research D17-D19. Architecture documentation
requirements are met below (trust boundary and data flows). **Phase gate**: this feature is Phase 1
(Security Foundation); it adds no autonomous actions.

**Attention items (none block planning)**:

1. **Provisional answers.** Five spec ambiguities are assumed, not confirmed (table below). One
   `/speckit-clarify` question is still unanswered.
2. **Task template conflict.** `.specify/templates/tasks-template.md` treats tests as optional.
   Constitution Principle XVII overrides that for every task in this feature. `/speckit-tasks`
   must generate the security tests as required tasks.
3. **Audit is stricter than the spec.** FR-040 requires durable audit before state-changing
   execution; the plan requires it before **every** execution, following Principle XVI (D13). A
   long audit outage therefore denies even SAFE actions. That is intentional.
4. **Delegated authority is a convention at the executor edge.** The contract passes each executor
   the user's own context, but an executor that then calls downstream systems with a service
   credential would reintroduce the confused deputy. The platform cannot detect that in general;
   it is a mandatory review item and a parity test per capability.
5. **Principle XI wording.** It lists "action definitions" as tenant-owned. The plan treats
   per-tenant *enablement* as tenant state and the *definitions* as global (D16). Confirm.

## Architecture

### Trust boundaries

```text
 UNTRUSTED                                   |  TRUSTED (server)
 -------------------------------------------+-----------------------------------------------
  user's browser (display-only; reports are  |
  untrusted, may only narrow)                |
        ^   typed, already-approved          |  composition root (wires everything)
        |   on-screen instructions           |
        |                                    |  +--------------------+
  LLM / model output  --- raw tool call -----+->| @dap/ai            |  planner runner
  retrieved documents (future)               |  | ProposalSubmitter  |  (our code; assigns callId,
        ^                                    |  +---------+----------+   run metadata)
        |  PlannerFeedback only              |            | ProposalCall
        |  (outcome + category)              |            v
        +------------------------------------+---- @dap/security --------------------------------+
                                             |  Policy Gateway                                   |
   host application (ports)                  |  context -> intake -> limits -> replay -> resolve |
   authentication, permissions, resource     |  -> validate -> authorize -> risk/confirm -> audit |
   checks, page context, confirmation  <-----+->  -> grant ---------------------+                |
   channel                                   |      state store (PostgreSQL, RLS) |               |
                                             +------------------------------------|---------------+
   user's own session  --- decide(id) -------+-> ConfirmationService (separate door)               |
                                             |                                    v               |
                                             |                          @dap/actions executors    |
                                             |                          (grant-checked, user's    |
                                             |                           own authority)           |
```

### Data flow: AI to action

1. The runner receives a model tool call and creates a `ProposalCall` (`callId`, raw text).
2. `gateway.forSession(ctx, run)` was bound earlier by the composition root; the runner calls
   `submit(call)`.
3. The Gateway runs the stages in research D6, ending at the first failure.
4. On `ALLOWED`: durable allow-event, grant minted, executor runs once, result event written.
5. The runner receives only `PlannerFeedback`. A UI effect, if any, is returned to the browser as a
   typed instruction by the composition root, not by the model.

### Data flow: confirmation to execution

1. Stage 7 stores a confirmation (normalized parameters, digest, definition hash, trusted
   consequence) and delivers its handle to the user's session through the host's channel. The
   planner gets `REQUIRES_CONFIRMATION` with no handle.
2. The user's session calls `ConfirmationService.decide`. The Gateway re-checks user, state, expiry,
   definition hash, digest, and authorization, consumes the confirmation atomically, writes the
   audit event, mints a grant, and executes the **stored** parameters.
3. At most once: a failed execution is audited and the user must start over.

Data flows for UI-to-AI and RAG-to-AI belong to the features that introduce those paths.

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-security-foundation/
├── plan.md              # This file
├── research.md          # Phase 0: decisions D1-D19 and open clarifications
├── data-model.md        # Phase 1: definition-time entities, runtime entities, tables
├── quickstart.md        # Phase 1: run-and-verify guide
├── contracts/           # Phase 1: interfaces and test catalogue
│   ├── README.md                 # index, package boundaries, how to add a capability
│   ├── core.ts                   # ids, RiskLevel, outcomes, reasons, stages
│   ├── action-definition.ts      # ActionDefinition, ActionRegistry
│   ├── security-context.ts       # AuthorizationContext and host ports
│   ├── gateway.ts                # PolicyDecision, PlannerFeedback, createPolicyGateway
│   ├── confirmation.ts           # ConfirmationRequest, ConfirmationService
│   ├── audit.ts                  # AuditEvent, AuditSink
│   ├── execution.ts              # ActionExecutor, ExecutionGrant
│   ├── state-ports.ts            # replay, rate limiting, stores
│   ├── testkit.ts                # hostile planner, scenarios, coverage
│   ├── security-test-catalogue.md
│   └── reference-host-api.md
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
packages/
├── contracts/                  # @dap/contracts: types, constants, defineExecutor wrapper
│   └── src/
│       ├── core.ts, action-definition.ts, gateway.ts, security-context.ts,
│       │   confirmation.ts, audit.ts, execution.ts, state-ports.ts
│       └── mint/               # restricted subpath: mints contexts and grants
├── ai/                         # @dap/ai: depends on contracts ONLY
│   └── src/ { planner-port.ts, tool-call.ts, index.ts }
├── security/                   # @dap/security: depends on contracts ONLY
│   └── src/
│       ├── context/            # SecurityContextFactory
│       ├── registry/           # buildRegistry, rules R1-R12, reserved names, hashing
│       ├── validation/         # strict intake, envelope, parameters, digest
│       ├── gateway/            # pipeline stages, decisions, feedback mapping, hook wrapper
│       ├── confirmation/       # ConfirmationService
│       ├── limits/             # limit orchestration over the RateLimiter port
│       ├── audit/              # projection, scrubber, event builder
│       └── state/              # postgres/ and memory/ adapters, conformance suite
├── actions/                    # @dap/actions: depends on contracts ONLY
│   └── src/index.ts            # empty now: production executors arrive with later features
└── testkit/                    # @dap/testkit: never imported by production code
    └── src/ { world, hostile-planner, attacks/, leak-scanner, recording-executor,
               coverage, test-capabilities/ }
apps/
└── reference-host/             # composition root and thin Fastify service (non-production)
    └── src/ { compose.ts, http/, dev-auth/, metrics.ts }
db/
└── migrations/                 # tables, forced RLS, privileges, audit append-only trigger
deploy/
├── docker/                     # Dockerfile (multi-stage, non-root)
├── compose.yaml                # host, postgres, prometheus, grafana
├── k8s/                        # Deployment (2+ replicas) and Service
├── prometheus/                 # scrape config and alert rules
└── grafana/                    # dashboard
tests/
├── architecture/               # import graph, manifests, no mutators, static scans
├── security/                   # runs the catalogue against every test capability
└── integration/                # HTTP-level flows against the reference host
.github/workflows/ci.yml
```

**Structure Decision**: an npm-workspaces monorepo with five small packages and one app. The
package split is the enforcement mechanism for "the AI layer must not import executors": a missing
manifest dependency fails the build, which is stronger than a lint rule alone. Unit tests sit next
to the code (`*.test.ts`). The attack suites live in `tests/security/` and take capabilities as
input so later features reuse them unchanged.

**Allowed dependency edges** (checked in CI by dependency-cruiser and a manifest test):

| From | May depend on |
|------|---------------|
| `contracts` | external libraries only (Zod types) |
| `ai`, `actions`, `security` | `contracts` |
| `testkit` | `contracts`, `security`, `ai` |
| `apps/reference-host` | all packages (it is the composition root) |

Everything else is forbidden. `@dap/contracts/mint` is importable only by `security` and `testkit`.

## Security Testing Strategy

Full catalogue: [`contracts/security-test-catalogue.md`](./contracts/security-test-catalogue.md).
Approach and rationale: research D17. Every row is proven by the recording executor staying at
zero calls, not only by a returned status.

| Required topic | How it is tested | Representative scenarios |
|----------------|------------------|--------------------------|
| Unknown actions | Exact-match lookups against never-registered names, reserved dangerous names, look-alikes (case, whitespace, zero-width, homoglyph), prototype keys, runtime registry mutation attempts | ATK-UNKNOWN-01..08 |
| Malformed parameters | Missing, mistyped, extra (top-level and nested), oversized, duplicate keys, prototype keys, depth and byte caps, identity-like keys, and a check-then-use mutation using getters or a Proxy | ATK-PARAMS-01..13, plus property tests on the strict intake |
| Privilege escalation | Permission denied through the AI path with a **parity oracle** against the direct path; role claims ignored; non-boolean hook answers denied; spoofed page context; expired session; revoked permission before accept | ATK-PRIV-01..08 |
| Cross-tenant access | Resource in another tenant (feedback byte-identical to nonexistent), tenant id in input, host returning a foreign resource, store-level isolation as the application role, independent claims, confirmations, counters, audit | ATK-XTENANT-01..10 |
| Confirmation bypass | Model claims, no AI path to `decide`, expiry, reuse, wrong user or tenant, tampered parameters, definition drift, lost authorization, 100 concurrent-accept trials, deceptive text, audit down | ATK-CONFIRM-01..16 |
| Replay | Duplicate `callId`, new Gateway instance, 50 parallel submissions across two instances, retention boundary, per-tenant independence, model-chosen ids rejected | ATK-REPLAY-01..08 |
| Prompt-injected requests | Scripted compromised-model proposals from an injection corpus; **metamorphic** test (injection text must not change any decision); injection inside resource names and audited values; envelope has no free-text decision channel | ATK-INJECT-01..06 |

Supporting techniques: canary secrets on every output (ATK-SECRET), fault injection across all
ports (ATK-DEP), audit failure modes (ATK-AUDIT), architecture and forged-grant checks
(ATK-ARCH), generated-input invariants (fast-check), positive controls so denials are not vacuous
(POS-01..04), a capability-by-scenario coverage gate (FR-048), and nightly mutation testing of the
security package.

## Delivery Increments (input for `/speckit-tasks`)

Each increment lands together with the catalogue scenarios for what it adds.

| # | Increment | Stories |
|---|-----------|---------|
| 1 | Workspace, TypeScript, lint rules, dependency-cruiser, contracts package, Zod behavior pins | foundation |
| 2 | Registry (R1-R12), strict intake, parameter validation and digest | US1, US2 |
| 3 | Context factory, host ports, Gateway pipeline on the in-memory adapter | US1, US3 |
| 4 | Audit projection, scrubber, durable-before-execute, grant minting and executor wrapper | US4 |
| 5 | PostgreSQL adapters, migrations, forced RLS, privileges, conformance suite | US3, US4 |
| 6 | Confirmation service, replay guard, rate limits and denial throttle | US5, US6 |
| 7 | Testkit completion, full catalogue, coverage gate, property and fault-injection suites | US7 |
| 8 | Reference host, metrics, Dockerfile, compose, Kubernetes manifests, CI workflow | delivery |

## Provisional Decisions and Open Clarifications

| Topic | Plan assumption | Status | If the answer differs |
|-------|-----------------|--------|-----------------------|
| Browser trust boundary | Display-only browser; server decides and executes everything (research D15) | `/speckit-clarify` question asked, **unanswered** | Execution model and trusted-input list change; re-plan |
| What constitutes a tenant | One active tenant per session context (D8) | Not asked | Context and every store key change; re-plan |
| Do denied calls reach the model | Only outcome type, category, and field paths (D14) | Not asked | Change `toPlannerFeedback` and its tests |
| Tenant-configurable definitions | No; per-tenant narrowing only (D16) | Not asked | Registry and enablement model change |
| Confirmation validity | 300 s default, 900 s maximum, may only shorten (D10) | Not asked | Configuration value only |

Recommended: run `/speckit-clarify` again to settle these before `/speckit-tasks`.

## Remaining Risks and Known Limitations

This design does not make the system "secure"; it makes specific failures structurally hard.
What remains:

1. **In-process supply-chain compromise** can reach the restricted mint functions. Mitigation is
   dependency scanning and review, not this design.
2. **Post-execution audit failure**: the action has already happened. It raises a metric and alert;
   reconciliation is out of scope.
3. **Fixed-window rate limits** allow up to twice the limit across a window boundary.
4. **Outcome type reveals one bit**: "unknown action" versus "not allowed for you". Low impact;
   a mapping change removes it (D14).
5. **Replay protection** covers duplicate delivery and resubmission within the retention window. It
   does not authenticate senders.
6. **Confirmation UI** must render outside any DOM the AI can drive. This feature cannot enforce
   that; it is a hard requirement on the future UI feature.
7. **Single PostgreSQL** is a dependency: when it is down everything is denied (by design).
8. **Executor authority** (attention item 4) depends on executor implementations and review.
9. **Reference host** includes a development-only authentication stub; mitigated by explicit
   opt-in and a production refusal, but it is attack surface in any shared environment.
10. **Unconfirmed assumptions** above.

## Complexity Tracking

No constitution violations to justify, so there are no entries. The five-package split is a
deliberate enforcement mechanism for Principle III and is explained under **Structure Decision**.
