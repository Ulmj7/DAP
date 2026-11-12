# Contracts: AI Security Foundation

**Feature**: `001-ai-security-foundation` | **Spec**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

These are the interfaces later AI features build against (spec FR-053). The TypeScript files are
type-only declarations. They were compile-checked with `tsc --strict` plus
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` against Zod 4.6.7. They contain no
behavior; behavior lives in the packages named below.

| File | Defines | Implemented in |
|------|---------|----------------|
| [`core.ts`](./core.ts) | Branded ids, `RiskLevel`, outcomes, reason codes, pipeline stages, `PlannerRunMeta` | `@dap/contracts` |
| [`action-definition.ts`](./action-definition.ts) | `ActionDefinition`, `ActionRegistry`, registration rules R1-R12 | `@dap/contracts` (types), `@dap/security` (`buildRegistry`) |
| [`security-context.ts`](./security-context.ts) | `AuthorizationContext`, host ports (`AuthenticationPort`, `PermissionChecker`, `ResourceAuthorizer`, `PageContextProvider`) | types in contracts; factory in `@dap/security`; ports by the **host** |
| [`gateway.ts`](./gateway.ts) | `ProposalCall`, `PolicyDecision`, `PlannerFeedback`, `PolicyGateway`, `createPolicyGateway` | `@dap/security` |
| [`confirmation.ts`](./confirmation.ts) | `ConfirmationRequest`, `ConfirmationService`, `ConfirmationChannel` | `@dap/security`; channel by the **host** |
| [`audit.ts`](./audit.ts) | `AuditEvent`, `AuditSink`, `AuditReader` | `@dap/security` |
| [`execution.ts`](./execution.ts) | `ActionExecutor`, `ExecutionGrant`, `defineExecutor`, `bindExecutors` | `@dap/contracts` (wrapper), executors in `@dap/actions` |
| [`state-ports.ts`](./state-ports.ts) | Replay, rate limiting, confirmation store, tenant policy | `@dap/security` (PostgreSQL + in-memory adapters) |
| [`testkit.ts`](./testkit.ts) | Hostile planner, attack scenarios, coverage report | `@dap/testkit` |
| [`security-test-catalogue.md`](./security-test-catalogue.md) | The attack scenarios every capability is tested against | `@dap/testkit` |
| [`reference-host-api.md`](./reference-host-api.md) | HTTP surface of the thin reference host | `apps/reference-host` |

## Package boundaries (enforced; research D4)

```text
                     +-------------+
        +----------->|  contracts  |<-----------+------------+
        |            +-------------+            |            |
   +----+----+        ^           ^        +-----+-----+  +---+----+
   |   ai    |        |           |        |  security |  | actions|
   +---------+   (types only)     |        +-----------+  +--------+
        |                         |             ^              |
        |   NO edge from ai, actions, or security to each other.|
        |                                                       |
        +--------------- composition root (reference host) -----+
                  wires all packages; the only place that
                  sees registry + executors + gateway together
   testkit --> contracts, security, ai        (never imported by production code)
```

**Allowed edges only**: every package to `contracts`; `testkit` to `security` and `ai`;
`apps/reference-host` to all. **Forbidden**: `ai` to `security` or `actions`; `actions` to `ai` or
`security`; `security` to `ai` or `actions`; any production package to `testkit`.
The restricted subpath `@dap/contracts/mint` may be imported only by `security` and `testkit`.

## What each party can hold at runtime

| Party | Holds | Never holds |
|-------|-------|-------------|
| AI layer (planner runner) | a `ProposalSubmitter` bound to one session and run | context, registry, executors, state store, confirmation service, audit reader |
| Security module | context factory, Gateway internals, state store, audit sink | executor implementations (injected opaque, via `ExecutorTable`) |
| Executors | a grant-checked `execute` | a way to mint grants or contexts |
| Trusted HTTP layer | `ConfirmationService`, context factory | the planner's submitter internals |
| Host application | the ports it implements (auth, permissions, resources, pages, confirmation channel) | any ability to bypass the Gateway |

## Pipeline

See research D6 for the ordered stage table and the spec FR mapping. In short: trusted context,
intake, global limits, replay claim, resolve and enable, strict validation, authorization, risk
and confirmation, durable audit, grant-checked execution. Any failure, throw, or timeout ends the
pipeline with a denial.

## Adding a capability (the contract for later features)

1. **Define** it with `defineAction({...})`: strict `inputSchema`, `risk`, `requiredPermission`,
   `allowedPages`, `confirmation`, `changesState`, `audit.params`, `resource`,
   `describeConsequence` (if confirmable), `executorId`, `version: 1`. Use no identity-like
   parameter names.
2. **Implement** its executor in `@dap/actions` with `defineExecutor`. It receives only validated
   parameters and the user's own context.
3. **Register** it by adding the definition to the list passed to `buildRegistry`, and bind the
   executor in the composition root. Startup fails with all registration issues if a rule is
   violated.
4. **Enable** it by adding its id to the global allowlist configuration. A tenant can then be
   narrowed per tenant. Nothing is enabled by default.
5. **Test** it: add it to the testkit target list so the full catalogue runs against it. The
   coverage gate fails the build for any applicable scenario that is not covered or waived.
6. **Bump `version`** on any later change; the drift test enforces this.

There is no step that adds a generic execution path, and none can be added: general execution
capabilities are FORBIDDEN by registration rule R7 and by a static scan (ATK-ARCH-10).
