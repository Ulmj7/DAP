---

description: "Task list for the AI Security Foundation feature"
---

# Tasks: AI Security Foundation

**Input**: Design documents from `/specs/001-ai-security-foundation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: **REQUIRED, not optional.** The Spec Kit default ("tests are optional") does not apply
here: constitution Principle XVII makes security tests mandatory for every AI capability, spec
FR-045..FR-049 define test infrastructure as a deliverable, and the request for this task list
includes security tests. Tests sit inside each story and are written **first**; they must fail
before the implementation that satisfies them.

**Organization**: Tasks are grouped by user story. Paths are repository-root relative. The design
files are in `specs/001-ai-security-foundation/`; contract sources are `contracts/*.ts`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `[US1]`..`[US7]` from spec.md. Setup, Foundational, and Delivery tasks have no label
- Quoted text in a task is a constraint copied verbatim from data-model.md or research.md

## Phase order (read this first)

Spec priorities are P1: US1, US2, US3, US4 and P2: US5, US6, US7. Within the P1 tier the phases are
ordered **by dependency**: **US2 (registry) comes before US1 (Gateway)** because the Gateway
consumes the registry. Task numbering follows execution order.

**RLS policy expression (finding from T026, applies to T048, T093, T102, T112, T113 and every later `sec_*` table)**: the policy MUST compare `tenant_id` to `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. After a transaction-local `set_config` ends, the setting reads back as the empty string, and the bare cast `current_setting('app.tenant_id', true)::uuid` then raises `22P02` instead of returning zero rows. With `NULLIF`, an unset or reset setting yields zero rows. The pinned test is in `packages/security/src/state/conformance/postgres/`.

**Provisional decisions** (research.md "Open clarifications", not yet confirmed by the user).
These tasks encode an assumption and change if the answer differs:

| Decision | Assumption | Tasks affected |
|----------|-----------|----------------|
| D8 tenant model | one active tenant per session; `TenantId` is a UUID | T020, T076 |
| D10 confirmation lifetime | 300 s default, 900 s max | T098, T100, T115 |
| D14 what the model sees | outcome + category + field paths only | T057, T064 |
| D15 browser boundary | display-only browser; server executes | T089, T131, T134 |
| D16 tenant-configurable definitions | no; narrowing only | T044, T050 |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Workspace, tooling, and the enforcement scaffolding for package boundaries

- [X] T001 Create root `package.json` (npm workspaces `packages/*` and `apps/*`; `engines.node` `>=22`), `.nvmrc` containing `22`, and `.gitignore` (`node_modules`, `dist`, `coverage`, `.env*`) at the repository root
- [X] T002 [P] Create `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, target ES2022, `module` and `moduleResolution` set to `NodeNext` (relative imports use `.js` specifiers), `composite` enabled for project references
- [X] T003 [P] Create `packages/contracts/` skeleton: `package.json` (`@dap/contracts`; `exports` for `.` and the restricted `./mint` subpath; `zod` as peer dependency), `tsconfig.json`, empty `src/index.ts`
- [X] T004 [P] Create `packages/ai/` and `packages/actions/` skeletons (`@dap/ai`, `@dap/actions`): each `package.json` depends on `@dap/contracts` ONLY, plus `tsconfig.json` and `src/index.ts`
- [X] T005 [P] Create `packages/security/` skeleton: `package.json` (`@dap/security`; dependencies `@dap/contracts`, `zod`, `pg` ONLY), `tsconfig.json`, `src/index.ts`
- [X] T006 [P] Create `packages/testkit/` skeleton: `package.json` (`@dap/testkit`; depends on `@dap/contracts`, `@dap/security`, `@dap/ai`; dev dependency `fast-check`), `tsconfig.json`, `src/index.ts`
- [X] T007 [P] Create `apps/reference-host/` skeleton: `package.json` (all `@dap/*` packages, `fastify`, `prom-client`, `pino`), `tsconfig.json`, `src/index.ts`
- [X] T008 [P] Create `eslint.config.js` (typescript-eslint) that bans `eval`, `new Function`, and dynamic `import()` with a non-literal specifier everywhere, and restricts imports of `@dap/contracts/mint` to `packages/security/**` and `packages/testkit/**`. Runtime lint also rejects forbidden literal dynamic imports, deep src/dist imports, and alternate `require`/`createRequire`/module loaders.
- [X] T009 [P] Create `dependency-cruiser.config.cjs` forbidding every edge not in plan.md "Allowed dependency edges": `ai` to `security` or `actions`; `actions` to `ai` or `security`; `security` to `ai` or `actions`; any production package to `testkit`. The `mint-entry-restricted`, `no-deep-imports-into-contracts`, and `no-runtime-module-loaders` rules also cover dynamic/require edges and retain dist targets.
- [X] T010 [P] Create `vitest.config.ts` (Vitest 5 replaced `vitest.workspace.ts` with `test.projects`; same project split: unit, conformance, arch, security, integration) and root `package.json` scripts `lint`, `typecheck`, `test`, `test:arch`, `test:security`, `test:conformance`, `test:integration`, `coverage:security`, `db:migrate`
- [X] T011 [P] Create `.github/workflows/ci.yml` running checkout, Node 22 setup, `npm ci`, `lint`, `typecheck`, `test:arch`, `test` on every push and pull request
- [X] T012 Run `npm install` to create `package-lock.json` (Zod on the 4.x line verified in research D2, 4.6.7) and confirm `npm run typecheck` passes on the empty skeletons (depends on T001-T007). Done: TypeScript is pinned to `~6.0.3` because `typescript-eslint` 8.x requires `<6.1.0`; workspace packages resolve to source through the custom export condition `@dap/source` (tsconfig `customConditions`, Vitest `resolve.conditions`, dependency-cruiser `conditionNames`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, trusted-minting runtime, hashing, database scaffolding, and the core of the
security test kit. Every story depends on this.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Contracts package

- [X] T013 [P] Define RiskLevel: port `specs/001-ai-security-foundation/contracts/core.ts` to `packages/contracts/src/core.ts` (`.js` import specifiers). `RISK_LEVELS` is exactly `["SAFE","LOW","MEDIUM","HIGH","CRITICAL","FORBIDDEN"]`, plus `RISK_RANK`, the seven `OUTCOMES`, `REASON_CODES`, `PIPELINE_STAGES`; add `packages/contracts/src/core.test.ts` asserting exact members and order (FR-007, FR-014)
- [X] T014 [P] Define the ActionDefinition shape: port the TYPES from `contracts/action-definition.ts` to `packages/contracts/src/action-definition.ts` (`ActionDefinition`, `AnyActionDefinition`, `RegisteredAction`, `ActionRegistry`, `RegistrationRule`, `RegistrationIssue`). Runtime pieces (`buildRegistry`, `RegistrationError`, reserved lists) belong to `@dap/security` (T041-T044), not here. `defineAction` is a type-level identity returning `ActionDefinition<TParams>`.
- [X] T015 [P] Port `contracts/security-context.ts` and `contracts/execution.ts` to `packages/contracts/src/security-context.ts` and `packages/contracts/src/execution.ts` (types only). `ExecutionCall` also has `actionId` and `paramsDigest`, mirrored in `specs/001-ai-security-foundation/contracts/execution.ts`.
- [X] T016 [P] Port `contracts/gateway.ts` and `contracts/confirmation.ts` to `packages/contracts/src/gateway.ts` and `packages/contracts/src/confirmation.ts` (types only; drop the `declare function` runtime signatures). The shared `ExecutionCall` now includes `actionId` and `paramsDigest`, and the spec contract matches.
- [X] T017 [P] Port `contracts/audit.ts`, `contracts/state-ports.ts`, `contracts/testkit.ts` to `packages/contracts/src/audit.ts`, `packages/contracts/src/state-ports.ts`, `packages/contracts/src/testkit.ts` (types and the `AUDIT_EVENT_TYPES` constant)
- [X] T018 Create barrel `packages/contracts/src/index.ts` exporting every module EXCEPT mint, and `packages/contracts/src/index.test.ts` asserting the root export exposes no mint function (depends on T013-T017)
- [X] T019 [P] Write `packages/contracts/src/mint/mint.test.ts` FIRST: a plain object literal with the same fields is not recognized as an `AuthorizationContext`; a spread copy of a minted context is not recognized; a forged grant fails; a grant is single-use; a grant bound to `(requestId, actionId, paramsDigest, tenantId, userId)` rejects any mismatch (ATK-ARCH-03, ATK-ARCH-04)
- [X] T020 Implement `packages/contracts/src/mint/index.ts`: module-private `WeakSet` for contexts and `WeakMap` for grants with a consumed flag; `mintAuthorizationContext`, `isMintedContext`, `mintExecutionGrant`, `consumeExecutionGrant` (depends on T019). `TenantId` is validated as a UUID by the caller in T076, not here. The private registries now live in `packages/contracts/src/mint/context-registry.ts` and `packages/contracts/src/mint/grant-registry.ts`.
- [X] T021 [P] Write `packages/contracts/src/execution-runtime.test.ts` FIRST: calling a `defineExecutor` executor with no grant throws and the body does not run; wrong-binding grant throws; consumed grant throws (ATK-ARCH-02)
- [X] T022 Implement `defineExecutor` (verifies and consumes the grant before running) and the identity helper `defineAction` in `packages/contracts/src/execution-runtime.ts` and `packages/contracts/src/define-action.ts`; export both from the barrel (depends on T020, T021). `defineAction` is a type-level identity returning `ActionDefinition<TParams>`; `defineExecutor` uses the private `mint/context-registry.ts` and `mint/grant-registry.ts`, verifies all five binding fields and a minted context, and passes a frozen call snapshot.

### Hashing, behavior pins, database scaffolding

- [X] T023 [P] Write `packages/security/src/validation/canonical.test.ts` FIRST (key order independence; rejects `undefined`, `NaN`, functions, cycles), then implement `packages/security/src/validation/canonical.ts`: canonical JSON and SHA-256 returning `Sha256Hex`, used for definition hashes and parameter digests
- [X] T024 [P] Write `packages/security/src/registry/zod-behavior.test.ts` pinning the verified Zod facts (research D2): `strictObject` rejects an extra key while plain `object` strips it; input-mode JSON Schema omits `additionalProperties` for a plain object, including one nested in a `strictObject`; `.max()` yields `maxLength` and `maxItems`; an unbounded string has no `maxLength`; `z.date()` throws under `unrepresentable: "throw"`; `JSON.parse` keeps the last duplicate key; `__proto__` becomes an own property
- [X] T025 Create database scaffolding: `deploy/compose.yaml` with a `postgres` service (version 16 or newer), `db/migrations/000_roles.sql` creating role `dap_owner` (owns tables) and role `dap_app` (login, NOT table owner, no `BYPASSRLS`), and migration runner `db/migrate.mjs` applying numbered SQL files in order and recording them, wired to `npm run db:migrate`
- [X] T026 Write `packages/security/src/state/postgres/tenant-tx.test.ts` FIRST (needs PostgreSQL), then implement `packages/security/src/state/postgres/tenant-tx.ts`: `withTenant(pool, tenantId, fn)` runs a transaction after `set_config('app.tenant_id', $1, true)`. Test table with forced RLS policy `tenant_id = current_setting('app.tenant_id', true)::uuid`: no setting returns zero rows; another tenant returns zero rows; inserting a row for another tenant is rejected (XTENANT-05 foundation) (depends on T025). The live test is placed in `packages/security/src/state/conformance/postgres/tenant-tx.test.ts` so it runs in the conformance project rather than unit tests.

### Test kit core

- [X] T027 [P] Create `packages/testkit/src/clock.ts` (`FakeClock` implementing `Clock`, with `advance(seconds)`) and `packages/testkit/src/ids.ts` (seeded deterministic `IdGenerator`)
- [X] T028 [P] Create `packages/testkit/src/recording-executor.ts`: `RecordingExecutor` built with `defineExecutor`, exposing `calls`, `grantsSeen`, `receivedParams`, configurable success or failure result
- [X] T029 [P] Create `packages/testkit/src/leak-scanner.ts` with unit tests: `LeakScanner` and canary-secret registry flagging canaries, stack-trace patterns, secret-shaped values (JWT-like, `sk-` and `AKIA` prefixes, 32 or more hex characters), any value from `REASON_CODES`, and UUID-shaped confirmation ids
- [X] T030 [P] Create `packages/testkit/src/test-capabilities/index.ts` with one definition per risk class using strict bounded schemas: `testSafeEcho` (SAFE), `testLowNavigate` (LOW), `testMediumDraft` (MEDIUM, `changesState`), `testHighPublish` (HIGH), `testCriticalDelete` (CRITICAL), `testForbiddenShell` (FORBIDDEN, no executor); ids match `^[a-z][A-Za-z0-9]{2,63}$`; HIGH and CRITICAL use `confirmation: { kind: "required" }` with `resource` extractors and `describeConsequence` built from the trusted resolved resource
- [X] T031 [P] Create `packages/testkit/src/host-fakes.ts`: configurable fakes for `AuthenticationPort`, `PermissionChecker`, `ResourceAuthorizer`, `PageContextProvider`, `ConfirmationChannel`, plus a "service identity" hook that records any call (for ATK-PRIV-04)
- [X] T032 [P] Create `packages/testkit/src/fault-injection.ts`: `faulty(port, mode)` with modes `throws`, `hangs`, `undefined`, `wrong-type`
- [X] T033 [P] Create `packages/testkit/src/audit-capture.ts`: in-memory `AuditSink` capturing events, with a switch that makes `append` fail
- [X] T034 Create `packages/testkit/src/world.ts`: tenants A and B (UUIDs), users per tenant (`alice` admin, `bob` member, `carol` read-only; the SAME user id strings reused in both tenants), resources per tenant, and a minted `AuthorizationContext` per user via `@dap/contracts/mint` (depends on T020, T027, T031)
- [X] T035 Create `packages/testkit/src/scenario-runner.ts`: `runScenario(scenario, target)` runs an `AttackScenario`, collects planner feedback, executor calls, and audit events, runs `LeakScanner` over all planner-visible output, and returns an `AttackObservation`; add a unit test with a trivial scenario (depends on T028, T029, T033, T034)

**Checkpoint**: Foundation ready. Contracts compile, minting works, hashing is stable, PostgreSQL scaffolding runs, the test kit core exists.

---

## Phase 3: User Story 2 - Capabilities only through a typed, allowlisted registry (Priority: P1)

**Goal**: Developers describe capabilities in a typed registry; only well-formed ones load; nothing is
usable until explicitly enabled; nothing can change the registry at runtime.

**Independent Test**: Register well-formed and ill-formed definitions: only well-formed ones load, none
is usable until enabled, per-tenant narrowing works, and the registry exposes no mutator (spec US2).
Covers ATK-UNKNOWN-07/08, ATK-ARCH-07/08/09.

### Tests for User Story 2 ⚠️ (write first, confirm they FAIL)

- [X] T036 [P] [US2] Write `packages/security/src/registry/registry.rules.test.ts`: a passing and a failing case for each of R1-R12; plain `z.object` rejected (R3, ATK-ARCH-09); unbounded string, unbounded array, and a nested plain object rejected; reserved parameter names (`userId`, `tenantId`, `role`, `confirmed`, `isAdmin`) rejected at any depth; id must match `^[a-z][A-Za-z0-9]{2,63}$`; `version` "Integer from 1"; `confirmationTtlSeconds` "at most the global default"
- [X] T037 [P] [US2] Write `packages/security/src/registry/registry.immutability.test.ts`: no register, remove, or replace method exists; registry is frozen; look-alike ids (case change, trailing space, zero-width character, Cyrillic homoglyph, Unicode normalization forms) and prototype keys (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) return no match (ATK-UNKNOWN-03/04/08, ATK-ARCH-07)
- [X] T038 [P] [US2] Write `packages/security/src/registry/enablement.test.ts`: default deny (empty allowlist); "enabled = in global allowlist and not disabled for the tenant"; an allowlist containing a FORBIDDEN or unknown id fails startup (ATK-UNKNOWN-07); a tenant disable takes effect on the very next call with no caching
- [X] T039 [P] [US2] Write `packages/security/src/registry/startup-report.test.ts`: `RegistrationError` carries ALL issues (not only the first) naming action id, rule, and detail (US2.2); duplicate ids abort startup (US2.3); identity-like parameter names rejected (US2.4)
- [X] T040 [P] [US2] Write `packages/security/src/registry/drift.test.ts`: snapshot of `{id, version, definitionHash, inputSchemaJson}` for every test capability; fails when a schema changes without a `version` bump (ATK-ARCH-08) Placement: the test and versioned JSON baseline live under `tests/security/` to preserve the security-to-testkit package boundary. Version increases also require an explicit reviewed baseline refresh before this gate passes.

### Implementation for User Story 2

- [X] T041 [P] [US2] Create `packages/security/src/registry/reserved-names.ts`: `RESERVED_PARAMETER_NAMES` (`userId`, `tenantId`, `sessionId`, `role`, `roles`, `permission`, `permissions`, `isAdmin`, `confirmed`, `confirmation`, `confirmationId`, `approved`, `authorization`, `token`, "compared case-insensitively, ignoring `_` and `-`"), `RESERVED_FORBIDDEN_ACTION_NAMES` (arbitrary script execution, shell and command execution, query execution, outbound requests, selector-based clicking or typing, credential and token retrieval, disabling audit, changing permissions), and `normalizeForClassification`
- [X] T042 [US2] Create `packages/security/src/registry/schema-rules.ts`: `inspectInputSchema(schema)` converts with `z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" })` and walks the result: every object node has `additionalProperties: false`; every string has `maxLength`; every array has `maxItems`; no reserved parameter name at any depth; a conversion error is an R3 issue (depends on T041). Hardening: unconstrained schemas, catch fallbacks, and metadata overriding validation keywords also fail R3 because JSON Schema alone could otherwise hide permissive runtime validation.
- [X] T043 [US2] Create `packages/security/src/registry/definition-hash.ts`: `definitionHash` is SHA-256 over canonical JSON of `{id, version, risk, requiredPermission, allowedPages, confirmation, changesState, inputSchemaJson}`, and the registry `fingerprint` is a hash over all definition hashes (depends on T023)
- [X] T044 [US2] Create `packages/security/src/registry/build-registry.ts` and `registration-error.ts`: `buildRegistry(definitions)` enforces R1 "All fields present and valid", R2 "Identifiers unique, exact", R3 "Schema strict, bounded, representable, free of reserved names", R4 "HIGH and CRITICAL: `confirmation = required`", R5 "MEDIUM: `required`, unless `not-required` carries a written justification string", R6 "SAFE and LOW may be `not-required`. A SAFE or LOW capability with `changesState = true` is rejected", R7 "FORBIDDEN definitions have no executor and cannot be enabled", R8 "Confirmation required implies `describeConsequence` present", R9 "`changesState` or resource-targeting implies `resource` present", R11 "`confirmationTtlSeconds` is at most the global default", R12 "Capabilities of MEDIUM risk or higher cannot opt out of auditing". It collects every issue, then throws `RegistrationError`. Returns a frozen Map-backed registry (`get`, `list`, `isReservedForbidden`, `fingerprint`) with NO mutators (depends on T041-T043)
- [X] T045 [US2] Create `packages/security/src/registry/bind-executors.ts`: `bindExecutors(registry, executors)` returns an `ExecutorTable` and enforces R10 "Every non-FORBIDDEN definition has exactly one executor bound; every executor is used" and R7 (depends on T044)
- [X] T046 [P] [US2] Create `packages/security/src/state/conformance/tenant-policy.conformance.ts`: default not disabled; `disabled = true` affects only that tenant; same action id in two tenants is independent; value read on every call (no caching)
- [X] T047 [US2] Create in-memory `packages/security/src/state/memory/tenant-policy.ts` implementing `TenantActionPolicyStore` (depends on T046)
- [X] T048 [US2] Create migration `db/migrations/010_sec_tenant_action_policy.sql`: columns `tenant_id`, `action_id`, `disabled`, `updated_at`, `updated_by`; "Primary key `(tenant_id, action_id)`"; row-level security enabled AND forced with a policy comparing `tenant_id` to `NULLIF(current_setting('app.tenant_id', true), '')::uuid` on read and write (NOT the bare cast: see the RLS policy note under Phase order); grants to `dap_app` (depends on T025) Upgrade hardening is in migration `011_sec_tenant_action_policy_grants.sql`, preserving the already-applied 010 checksum while restoring the exact ACL.
- [X] T049 [US2] Create `packages/security/src/state/postgres/tenant-policy.ts` using `withTenant`, and `packages/security/src/state/conformance/tenant-policy.test.ts` running the T046 suite against BOTH the memory and PostgreSQL adapters (depends on T026, T047, T048)
- [X] T050 [US2] Create `packages/security/src/registry/enablement.ts`: `createEnablementPolicy({registry, globalAllowlist, tenantPolicy})`, "enabled = in global allowlist and not disabled for the tenant", validating the allowlist at startup (unknown or FORBIDDEN ids rejected); the allowlist defaults to empty (depends on T044, T047). Scope adjustment: it was first built and tested against the `TenantActionPolicyStore` port with a local fake; the memory and Postgres adapters (T046–T049) now implement that same port and share the write-side `TenantPolicyWriter` contract.
- [X] T051 [US2] Export the registry and enablement public API from `packages/security/src/index.ts` and make T036-T040 and T049 pass

**Checkpoint**: User Story 2 is complete. The registry loads only valid definitions and nothing is enabled by default.

---

## Phase 4: User Story 1 - Hostile or invalid AI requests fail closed (Priority: P1) 🎯 MVP for the boundary

**Goal**: Every proposal is stopped before application code runs unless positively proven allowed. Unknown,
malformed, forbidden, and false-claim proposals all fail closed with a safe result.

**Independent Test**: Feed hostile and malformed proposals through a Gateway built from test doubles and
a recording executor: the executor is never invoked and each result type matches (spec US1). At this
point the Gateway denies EVERYTHING, because the authorization, audit, and execute stages do not exist
yet (a terminal guard denies after validation). That default is the fail-closed state; the allowed path
arrives in US4. Covers ATK-UNKNOWN-01..06, ATK-PARAMS-01..13, ATK-INJECT-01/02/05/06, ATK-ARCH-01/05/06/10.

### Tests for User Story 1 ⚠️ (write first, confirm they FAIL)

- [ ] T052 [P] [US1] Create `packages/testkit/src/attacks/unknown-action.ts` (ATK-UNKNOWN-01..06: never-registered, reserved names, look-alikes, prototype keys, not globally enabled, disabled for tenant) and `tests/security/unknown-action.test.ts`; every scenario ends with `executorCalls === 0`
- [ ] T053 [P] [US1] Create `packages/testkit/src/attacks/malformed-parameters.ts` (ATK-PARAMS-01..13: missing, mistyped, extra top-level, extra nested at depth 3, oversized, duplicate keys, prototype keys, depth cap, byte cap, non-finite numbers, identity-like keys, getter/Proxy check-then-use, extra envelope keys) and `tests/security/malformed-parameters.test.ts`
- [ ] T054 [P] [US1] Create `packages/testkit/src/attacks/prompt-injection.ts` with `injection-corpus.ts` (instruction overrides, fake system or developer messages, role-play as admin, "the user already confirmed", tool-name spoofing, fake tool results, markdown, HTML, base64, and Unicode-obfuscated variants) implementing ATK-INJECT-01 (scripted compromised model), 02 (metamorphic: substituting any corpus string for benign text changes no outcome, reason, or executor count), 05 (injection text as action name), 06 (envelope has exactly `action` and `params`), and `tests/security/prompt-injection.test.ts`
- [X] T055 [P] [US1] Write `packages/security/src/validation/strict-json.test.ts`: duplicate keys; `__proto__`, `constructor`, `prototype` keys; depth above 8; payload above 16384 bytes; non-finite numbers; fast-check property: the result never contains a prototype key or two colliding keys Adds a hostile-input suite: RFC 8259 syntax and escapes, lone surrogates, exact depth and byte boundaries, escaped duplicate and forbidden keys, and the already-parsed path.
- [ ] T056 [P] [US1] Write `packages/security/src/validation/params.test.ts`: strict validation; normalized output is deeply frozen; getter or Proxy input is copied once (ATK-PARAMS-12); issues carry paths and generic codes (`required`, `type`, `unknown_key`, `too_long`, `too_many`, `out_of_range`, `format`, `invalid`) and NEVER values
- [X] T057 [P] [US1] Write `packages/security/src/gateway/feedback.test.ts`: `toPlannerFeedback` is total over every (outcome, reason) pair, matches the research D14 table, never exposes an internal reason, id, or value, and the `resource_not_available` variants are byte-identical (FR-015, FR-025) Privacy projection caps issues at 64 and collapses unknown, sensitive, or non-identifier paths to the root while retaining generic codes only.
- [X] T058 [P] [US1] Write `packages/security/src/gateway/fail-closed.test.ts`: any stage that throws, times out, or returns malformed data yields `DENIED` (`internal_error` or `dependency_failure`), never `ALLOWED`; creating a gateway with a missing dependency throws (FR-016, FR-023, US1.6) Also covers wrong-type methods, malformed config and fingerprint, stage attribution, id binding and premature ALLOWED or confirmation outcomes.
- [ ] T059 [P] [US1] Write `tests/architecture/graph.test.ts` (ATK-ARCH-01/05/06): runs dependency-cruiser and a workspace-manifest check; no forbidden edge; importing `@dap/contracts/mint` outside `security` and `testkit` fails lint; `eval` and `new Function` fail lint. Phase 2 already added `tests/architecture/contracts-boundary.test.ts` and `tests/architecture/module-loaders.test.ts`; extend them rather than recreate them.
- [X] T060 [P] [US1] Write `tests/architecture/static-scan.test.ts` (ATK-ARCH-10, FR-050): no `child_process`, `vm`, `node:http`, `node:https`, `fetch`, `undici`, or `axios` in `packages/ai`, `packages/actions`, `packages/security` (the `pg` driver is allowed only under `packages/security/src/state/postgres`) Type-only imports emit nothing and are not findings (a test pins `verbatimModuleSyntax`); the scan also bans net, tls, http2, dgram, dns, inspector, repl and module, the global object and its aliases, and non-literal module loads.

### Implementation for User Story 1

- [X] T061 [P] [US1] Create `packages/security/src/validation/strict-json.ts`: strict intake with `maxPayloadBytes` 16384 and `maxJsonDepth` 8; rejects duplicate keys, `__proto__`/`constructor`/`prototype` keys, and non-finite numbers; an already-parsed input is deep-copied once into plain data before any check Lone surrogates are rejected and `-0` is normalized to 0; an already-parsed value is charged against the same byte cap as compact JSON, shared references are accepted, cycles and hidden properties are rejected, and an invalid cap throws.
- [X] T062 [P] [US1] Create `packages/security/src/validation/envelope.ts`: strict envelope `{action, params}`; `action` must match `^[a-z][A-Za-z0-9]{2,63}$`; any extra key (`callId`, `requestId`, `userConfirmed`, and so on) yields `INVALID_ACTION` Takes the gateway caps as options, and a non-finite number is `INVALID_PARAMETERS` with `invalid_parameters` per ATK-PARAMS-10; every other intake failure is `INVALID_ACTION`.
- [X] T063 [US1] Create `packages/security/src/validation/params.ts`: `validateParams(definition, params)` returns `{ok, normalized (deep-frozen), paramsDigest}` or `{ok: false, issues}`; `paramsDigest` is SHA-256 over canonical JSON of `{actionId, version, params, resource, tenant, user}` (depends on T023, T061) Signature is `validateParams(definition, params, { tenantId, userId }, options?)`: tenant and user are required because the digest binds them and cannot be derived from the first two arguments; `paramsDigest(...)` is exported so T105 can recompute it. Every guard in `params.ts` is pinned by a test that fails without it (hand-made mutants, all killed except the two unreachable text-only strict-json code mappings).
- [X] T064 [P] [US1] Create `packages/security/src/gateway/decision.ts` (`PolicyDecision` builders) and `packages/security/src/gateway/feedback.ts` (`toPlannerFeedback` implementing the research D14 table verbatim)
- [X] T065 [P] [US1] Create `packages/security/src/gateway/hook-wrapper.ts`: wraps host ports with a timeout (`hookTimeoutMs` default 2000) and answer-shape validation; boolean ports allow only the literal `true`; any throw, timeout, or wrong shape is a denial Adapter semantics: Promise<void> completion is valid but bare undefined is not; tenant narrowing passes only literal false, the inverse of permission checks.
- [X] T066 [US1] Create `packages/security/src/gateway/pipeline.ts`: ordered stage runner per research D6; stops at the first failing stage; maps any throw to `DENIED` with `internal_error`; `ALLOWED` can only come from the terminal execute stage; a missing later stage makes a terminal guard return `DENIED` with `dependency_failure` (depends on T064, T065) Each stage deadline equals `hookTimeoutMs`; only intake is handed the proposal, as a read-once frozen snapshot, and rate-limit, replay, authorize, risk, confirmation, audit and execute attach by name in `StageMap`.
- [X] T067 [US1] Create stages `packages/security/src/gateway/stages/context.ts` (minted-context check via `isMintedContext`; expired yields `UNAUTHORIZED`), `intake.ts`, `resolve.ts` (exact Map lookup; reserved names yield `FORBIDDEN_POLICY` with `reserved_forbidden_action`; unknown yields `INVALID_ACTION`; not enabled yields `DENIED` with `action_not_enabled` or `tenant_action_disabled`; a FORBIDDEN-class entry is never allowed), and `validate.ts` (depends on T050, T061-T063, T066) `intake.ts` publishes `facts.intake = {callId, action, params}` (a malformed `callId` is a runner defect, `DENIED` with `dependency_failure`) and keeps an escaped, bounded `attemptedAction` for audit only; `validate.ts` re-proves the resolved definition and publishes `facts.validate = {params, paramsDigest, resource}`; both are composed in `createPolicyGateway`, but resolve and validate stay unreachable from it until the rate-limit and replay stages (T117) exist.
- [X] T068 [US1] Create `packages/security/src/gateway/create-gateway.ts`: `createPolicyGateway(deps)` returns `{proposals, confirmations}`; construction throws when any dependency is missing; `proposals.forSession(ctx, run)` returns a `ProposalSubmitter` whose `submit` returns `PlannerFeedback` ONLY; `confirmations` is a fail-closed placeholder (`decide` returns `not_valid` with `not_found`, `listPending` returns `[]`) replaced in T106 (depends on T066, T067) The proposal door lives in `gateway/submitter.ts` so its ids, binding and feedback-only output are testable; intake and validate join the composition with T067.
- [X] T069 [P] [US1] Create `packages/ai/src/planner-port.ts` (`PlannerPort` interface, imports `@dap/contracts` only), `packages/ai/src/tool-call.ts` (`toProposalCall(callId, rawArgumentsText)` passes the raw text UNTOUCHED), `packages/ai/src/index.ts`, and `packages/ai/src/tool-call.test.ts` asserting the text is neither parsed nor modified and that `@dap/ai` exports no executor, registry, context, or confirmation-service type The export surface is read from the type checker, and tests pin the allowed imports, the manifest and a frozen `ProposalCall`.
- [ ] T070 [US1] Extend `packages/testkit/src/world.ts` with `withGateway()`: registry from test capabilities, a `RecordingExecutor` per capability, host fakes, an "unused state store" stub that throws if touched, `createPolicyGateway`, and a bound `ProposalSubmitter` per user (depends on T034, T068)
- [ ] T071 [US1] Make the suites in `tests/security/` and `tests/architecture/` (T052-T060) pass with `npm run test:security` and `npm run test:arch`, and confirm the checkpoint: every scenario leaves its recording executor at zero calls

**Checkpoint**: User Story 1 works independently: the boundary fails closed. (The allowed path comes with US4.)

---

## Phase 5: User Story 3 - Identity, tenant, and permissions enforced (Priority: P1)

**Goal**: Identity, tenant, and permission come only from the host's trusted checks. The AI can never exceed
the user and never cross tenants.

**Independent Test**: Run proposals as users with differing permissions and tenants, including ones aimed at
other users' or other tenants' resources, and compare each outcome with the direct path (spec US3). The
"allowed runs with the user's own authority" scenario (US3.6) is proven in US4 once execution exists.
Covers ATK-PRIV-01/02/05/06/07/08, ATK-XTENANT-01..04.

### Tests for User Story 3 ⚠️ (write first, confirm they FAIL)

- [ ] T072 [P] [US3] Create `packages/testkit/src/attacks/privilege-escalation.ts` (ATK-PRIV-01, 02, 05, 06, 07, 08), the parity oracle `packages/testkit/src/parity.ts` (same user through the direct host check must also be denied), and `tests/security/privilege-escalation.test.ts`
- [ ] T073 [P] [US3] Create `packages/testkit/src/attacks/cross-tenant.ts` (ATK-XTENANT-01..04; feedback for other-tenant, nonexistent, and same-tenant-unauthorized resources must be byte-identical) and `tests/security/cross-tenant.test.ts`
- [X] T074 [P] [US3] Write `packages/security/src/context/factory.test.ts`: strict principal shape (extra or missing fields, non-UUID tenant, non-ISO instants rejected); expired principal yields null; host port throws, hangs, or returns the wrong type yields null; factory output is recognized by `isMintedContext` and a plain literal is not (ATK-ARCH-04) Also pins: identifiers are printable and at most 256 characters, the tenant is lowercase and not the nil UUID, and a session that has not begun is null.
- [X] T075 [P] [US3] Write `packages/security/src/gateway/stages/authorize.test.ts`: fault injection on the `permissions`, `resources`, and `pages` ports (throws, hangs, `undefined`, wrong type) all yield `UNAUTHORIZED` or `DENIED`; only literal `true` allows; resource tenant different from context tenant yields `tenant_mismatch` (ATK-XTENANT-04) Runs the stage against fault-injected ports, a runner-budget suite, and three byte-identical planner-feedback cases for a resource that is not the user's.

### Implementation for User Story 3

- [X] T076 [US3] Create `packages/security/src/context/factory.ts`: `createSecurityContextFactory({authentication, clock})` validates the principal with a strict schema (`tenantId` is a UUID per research D8; `authenticatedAt` and `validUntil` are ISO instants; `validUntil` in the future), mints via `@dap/contracts/mint`, returns null otherwise; the context holds NO permissions The factory reads each port method once and keeps the host receiver; there was no placeholder context creation in `create-gateway.ts` to replace.
- [X] T077 [US3] Create `packages/security/src/gateway/stages/authorize.ts`: (a) `validUntil` passed yields `UNAUTHORIZED` `session_expired`; (b) `PermissionChecker.has` must return literal `true`, else `UNAUTHORIZED` `permission_missing`; (c) page narrowing: a restricted `allowedPages` with a null or different current page yields `DENIED` `context_not_allowed`, and context never grants; (d) resource: `definition.resource(params)` then `ResourceAuthorizer.resolve(ctx, ref, permission)`; null yields `DENIED` `resource_not_available`; a returned `tenantId` different from `ctx.tenantId` yields `DENIED` `tenant_mismatch`; both look identical to the planner. Every host call goes through T065 A host fault is `DENIED` with `dependency_failure` (try_later) while a definite no is `UNAUTHORIZED` with `permission_missing`; hooks run one after another and each is capped by `min(hookTimeoutMs, remaining proposal budget)`; the resource comes from `facts.validate` (validate already ran the extractor once).
- [ ] T078 [US3] Wire the authorize stage (stage 6) into `packages/security/src/gateway/pipeline.ts`, update `world.withGateway()` to use it, and make T072-T075 pass Progress: authorize is composed as stage 6 in `composeStages`, and `pipeline.ts` now enforces `proposalBudgetMs` (default 10000, optional in `GatewayConfig`) across stages; `world.withGateway()` (T070) and the attack suites T072-T073 do not exist yet, so this stays open.

**Checkpoint**: User Stories 2, 1, and 3 all work. Identity and tenant are enforced; allowed execution still comes with US4.

---

## Phase 6: User Story 4 - Every proposal and decision is auditable (Priority: P1)

**Goal**: A reviewer can reconstruct what the AI attempted, why it was allowed or denied, who authorized it,
and what changed. No action runs without a durable audit record. This story also turns on the allowed path.

**Independent Test**: Run allowed, denied, and failing-audit proposals, then check events and fields (spec
US4). Covers ATK-AUDIT-01..07, ATK-SECRET-01..04, POS-01, ATK-PRIV-04, SC-008.

### Tests for User Story 4 ⚠️ (write first, confirm they FAIL)

- [ ] T079 [P] [US4] Write `packages/security/src/audit/event-builder.test.ts` (audit event model): tenant and user from the context; `aiSessionId`, `turnId`, `model` from trusted run metadata; attempted action name truncated to 64 characters; no model free text in any field; all nine event types
- [ ] T080 [P] [US4] Write `packages/security/src/audit/projection.test.ts`: only paths listed in `audit.params` are recorded ("Anything not listed is omitted"); `masked` fields become `"[masked]"`; newline, ANSI, and JSON-breaking characters stay inside one structured value (ATK-INJECT-04); scrubber redacts JWT-like, `sk-`, `AKIA`, and 32 or more hex values
- [ ] T081 [P] [US4] Create `packages/testkit/src/attacks/audit.ts` (ATK-AUDIT-01..05, 07: audit failure blocks every allowed risk class; a denial survives an audit failure; post-execution audit failure increments telemetry; event linkage; projection; no import path from `ai` to an audit reader) and `tests/security/audit.test.ts`
- [ ] T082 [P] [US4] Create `packages/testkit/src/attacks/secret-extraction.ts` (ATK-SECRET-01..04: canary secrets never reach planner output or audit; scripted `getPassword`/`readEnv` proposals; hook error text never surfaces; stack-trace scan) and `tests/security/secret-extraction.test.ts`
- [ ] T083 [P] [US4] Create `packages/testkit/src/attacks/positive-controls.ts` (POS-01 permitted user with enabled SAFE capability executes exactly once with exactly the validated parameters; ATK-PRIV-04 executor receives the requesting user's own context and the service-identity hook is never invoked) and `tests/security/positive.test.ts`
- [ ] T084 [P] [US4] Write `tests/integration/audit-trail.test.ts` (SC-008): from events alone, answer what was attempted, why it was allowed or denied, who authorized it, and what resource changed, for a sample of 20 mixed actions

### Implementation for User Story 4

- [ ] T085 [P] [US4] Create `packages/security/src/audit/projection.ts` and `packages/security/src/audit/scrubber.ts`
- [ ] T086 [P] [US4] Create `packages/security/src/audit/event-builder.ts`: builds `AuditEvent` with every field from a trusted source
- [ ] T087 [US4] Create `packages/security/src/gateway/telemetry.ts`: `GatewayTelemetry` interface (decisions by outcome, reason, risk, action; audit write failures; dependency failures; rate-limit hits) with a no-op default
- [ ] T088 [US4] Create `packages/security/src/audit/audit-writer.ts`: wraps `AuditSink.append` with a timeout; `recordProposed` (best effort, awaited), `recordDecision` for denials (a failure never changes the denial), `recordAllowedDurably` (a failure makes the caller return `DENIED` `audit_unavailable`), `recordExecuted` (depends on T086, T087)
- [ ] T089 [US4] Create stages `packages/security/src/gateway/stages/audit.ts` (stage 8: durable `AI_ACTION_ALLOWED` before EVERY execution, including SAFE) and `stages/execute.ts` (stage 9: mint a grant bound to `(requestId, actionId, paramsDigest, tenantId, userId)`, resolve the executor via `ExecutorTable`, run it with the frozen validated params, the user's own context, and the resolved resource; executor failure is audited as `AI_ACTION_EXECUTED` with `failure` and the planner sees `ALLOWED` with category `try_later`; success gives category `ok`). Emit `AI_ACTION_PROPOSED`, `AI_ACTION_DENIED`, and `AI_POLICY_VIOLATION` at the matching points (denied-action and allowed-action logging) (depends on T088)
- [ ] T090 [US4] Wire stages 8 and 9 and the event emission into `packages/security/src/gateway/pipeline.ts`; this is the first task that makes `ALLOWED` reachable (depends on T089)
- [X] T091 [US4] Add the executor-failure row (`ALLOWED` with category `try_later`) to research.md D14 and the `PlannerFeedback` comment in `contracts/gateway.ts`, and keep `packages/security/src/gateway/feedback.test.ts` consistent
- [ ] T092 [P] [US4] Create in-memory `packages/security/src/state/memory/audit.ts` and the tenant-scoped reviewer path `packages/security/src/audit/audit-reader.ts` (tenant comes from the context; `AuditQuery.limit` required)
- [ ] T093 [US4] Create migration `db/migrations/020_sec_audit_events.sql`: columns `id` (uuid PK), `occurred_at` (timestamptz default `now()`), `event_type`, `request_id`, `decision_id`, `user_id`, `ai_session_id`, `turn_id`, `model`, `action_id` (nullable), `definition_version` (nullable), `params_view` (jsonb), `risk` (nullable), `outcome`, `reason`, `confirmation_id` (nullable), `confirmation_state` (nullable), `execution_result` (nullable), `resource_type` and `resource_id` (nullable); indexes `(tenant_id, occurred_at)`, `(tenant_id, request_id)`, `(tenant_id, user_id, occurred_at)`; row-level security enabled AND forced; "Privileges: insert and select only for the application role", with a trigger rejecting update, delete, and truncate (depends on T025)
- [ ] T094 [US4] Create `packages/security/src/state/postgres/audit.ts` (sink and reader), `packages/security/src/state/conformance/audit.conformance.ts` run against memory and PostgreSQL, and a test as role `dap_app` showing update, delete, and truncate fail (ATK-AUDIT-06) and that a reviewer in tenant A sees no tenant B events (ATK-XTENANT-09)
- [ ] T095 [US4] Make T079-T084 pass (`packages/security/src/audit/*.test.ts`, `tests/security/audit.test.ts`, `tests/security/secret-extraction.test.ts`, `tests/security/positive.test.ts`, `tests/integration/audit-trail.test.ts`) and confirm the checkpoint: POS-01 executes once, every denial leaves the executor at zero

**Checkpoint**: All P1 stories (US2, US1, US3, US4) work. The core boundary is complete: a valid proposal can run, every other path is denied and audited.

---

## Phase 7: User Story 5 - Dangerous operations need server-verified confirmation (Priority: P2)

**Goal**: High-risk capabilities never run on the AI's say-so. A confirmation is server-created, single-use,
time-limited, bound to one action, resource, and user, and decided through a separate door.

**Independent Test**: Propose a high-risk test capability, verify nothing runs, accept via the trusted path and
verify it runs once, then attempt every misuse (spec US5). Covers ATK-CONFIRM-01..16, ATK-PRIV-03, ATK-INJECT-03, ATK-XTENANT-07, POS-02/03/04.

### Tests for User Story 5 ⚠️ (write first, confirm they FAIL)

- [ ] T096 [P] [US5] Create `packages/testkit/src/attacks/confirmation-bypass.ts` (ATK-CONFIRM-01..16, ATK-PRIV-03, ATK-INJECT-03, POS-02 MEDIUM confirms by default and runs once after accept, POS-03, POS-04) and `tests/security/confirmation.test.ts`; includes 100 trials of two concurrent accepts and the deceptive-text case whose consequence must come from the trusted resource display name
- [ ] T097 [P] [US5] Create `packages/security/src/state/conformance/confirmation.conformance.ts`: create, get, listPending, `tryAccept`, `tryReject`, `invalidate`, `recordExecution`; across 100 trials two concurrent `tryAccept` calls yield exactly one `true`; expiry by the store clock; another tenant or user can neither read nor accept (ATK-XTENANT-07)
- [ ] T098 [P] [US5] Write `packages/security/src/confirmation/binding.test.ts`: `paramsDigest` changes with action, version, parameters, resource, tenant, and user; definition-hash drift is detected; TTL is 300 s by default, never above 900 s, and a capability may only shorten it
- [ ] T099 [P] [US5] Write `packages/security/src/gateway/stages/risk-confirmation.test.ts`: confirmation matrix (SAFE and LOW none; MEDIUM required unless opted out with justification; HIGH and CRITICAL always); `REQUIRES_CONFIRMATION` feedback contains no id or token; a failing confirmation channel does not change the decision; nothing executes

### Implementation for User Story 5

- [ ] T100 [P] [US5] Create `packages/security/src/confirmation/binding.ts`: build the confirmation fields (`definitionVersion`, `definitionHash`, normalized `params`, `paramsDigest`, resource, user, tenant, risk, consequence), `requiresConfirmation(definition)` per FR-010, and `effectiveTtlSeconds(definition, config)` (default 300, maximum 900, shorten only)
- [ ] T101 [P] [US5] Create in-memory `packages/security/src/state/memory/confirmations.ts` (expiry driven by `FakeClock`)
- [ ] T102 [US5] Create migration `db/migrations/030_sec_confirmations.sql`: `id` (uuid PK), `user_id`, `request_id`, `action_id`, `definition_version`, `definition_hash`, `params` (jsonb), `params_digest`, `resource_type`, `resource_id`, `risk`, `consequence` (jsonb), `status` (`pending`, `accepted`, `rejected`, `invalidated`), `execution_status` (`none`, `succeeded`, `failed`), `created_at`, `expires_at` (database `now()` plus TTL), `decided_at`; index `(tenant_id, user_id, status, expires_at)`; row-level security forced (depends on T025)
- [ ] T103 [US5] Create `packages/security/src/state/postgres/confirmations.ts`: `tryAccept` as ONE statement `UPDATE ... WHERE status='pending' AND expires_at > now() AND user_id = $n RETURNING`, plus `tryReject`, `invalidate`, `recordExecution`, `listPending`; run the T097 conformance suite on memory and PostgreSQL (depends on T097, T101, T102)
- [ ] T104 [US5] Create `packages/security/src/gateway/stages/risk-confirmation.ts` (stage 7): create the confirmation with the handle from `IdGenerator.newConfirmationId()` (a crypto-grade UUID; no separate secret token, research D10), build the consequence with `describeConsequence({params, resource})` from the TRUSTED resolved resource, deliver through `ConfirmationChannel` (a failure is logged and the decision is unchanged), audit `AI_CONFIRMATION_REQUIRED`, return `REQUIRES_CONFIRMATION` (depends on T100, T103)
- [ ] T105 [US5] Create `packages/security/src/confirmation/service.ts`: `listPending` and `decide`. Accept order: load inside the tenant scope; check same user, still pending, not expired, current definition hash equals the stored one, recomputed digest equals the stored digest, capability still enabled for the tenant; RE-RUN the authorize stage (T077) for every confirmable capability; consume atomically with `tryAccept`; durable audit (`AI_CONFIRMATION_ACCEPTED` then the allow-event); mint a grant; execute the STORED parameters; record the execution status. Reject writes `AI_CONFIRMATION_REJECTED`. At most once: a failed execution is audited and never retried (depends on T077, T089, T104)
- [ ] T106 [US5] Replace the placeholder in `packages/security/src/gateway/create-gateway.ts` with the real `ConfirmationService`, wire stage 7 into `pipeline.ts`, and make T096-T099 pass

**Checkpoint**: User Story 5 works independently of US6 and US7.

---

## Phase 8: User Story 6 - Abuse limits and replay protection (Priority: P2)

**Goal**: A looping or hostile AI cannot drive the application with thousands of requests, keep retrying
denied actions, or resubmit a processed request. Limits and replay checks hold across restarts and replicas.

**Independent Test**: Drive a scripted planner that floods, retries denied actions, and resubmits, then verify
execution counts stay within limits and every replay is rejected, including from a second Gateway instance
(spec US6). Covers ATK-REPLAY-01..08, ATK-RATE-01..08, ATK-XTENANT-06/08.

### Tests for User Story 6 ⚠️ (write first, confirm they FAIL)

- [ ] T107 [P] [US6] Create `packages/testkit/src/attacks/replay.ts` (ATK-REPLAY-01..08, ATK-XTENANT-06: duplicate `callId`, new Gateway instance on the same database, 50 parallel submissions across two instances, retention boundary, per-tenant independence, model-supplied ids rejected, invalid-then-corrected resubmission) and `tests/security/replay.test.ts`
- [ ] T108 [P] [US6] Create `packages/testkit/src/attacks/rate-abuse.ts` (ATK-RATE-01..08, ATK-XTENANT-08: 10,000 proposals in one turn execute at most the per-turn cap with bounded database round trips; per-user; per-capability; HIGH and CRITICAL per hour; denial throttle; limiter unavailable; depth cap; wall-clock budget) and `tests/security/rate-abuse.test.ts`
- [ ] T109 [P] [US6] Create `packages/security/src/state/conformance/replay.conformance.ts` (atomic claim; independent per tenant; retention) and `packages/security/src/state/conformance/rate-limiter.conformance.ts` (atomic count; window; `block` and `isBlocked`; tenant independence)

### Implementation for User Story 6

- [ ] T110 [P] [US6] Create in-memory `packages/security/src/state/memory/replay.ts` implementing `ReplayGuard`
- [ ] T111 [P] [US6] Create in-memory `packages/security/src/state/memory/rate-limiter.ts` implementing `RateLimiter`
- [ ] T112 [US6] Create migration `db/migrations/040_sec_replay_claims.sql`: `namespace`, `claim_key`, `claimed_at`, `expires_at`; "Primary key `(tenant_id, namespace, claim_key)`"; row-level security forced (depends on T025)
- [ ] T113 [US6] Create migration `db/migrations/050_sec_rate_counters.sql`: `bucket_key`, `window_start`, `count`, `expires_at`; "Primary key `(tenant_id, bucket_key, window_start)`"; row-level security forced (depends on T025)
- [ ] T114 [US6] Create `packages/security/src/state/postgres/replay.ts` (`INSERT ... ON CONFLICT DO NOTHING`; zero rows inserted means duplicate) and `packages/security/src/state/postgres/rate-limiter.ts` (`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; block rows), and run T109 on memory and PostgreSQL (depends on T109, T110-T113)
- [ ] T115 [P] [US6] Create `packages/security/src/limits/limit-config.ts` with defaults from research D12: proposals per turn 25; executions per turn 8; chain depth 4; turn budget 30 s; per user per minute 60; per tenant per minute 600; per user and capability per minute 20; HIGH and CRITICAL per user per hour 10; denial throttle 5 denials in 60 s blocks the session for 300 s; replay retention 86400 s; confirmation TTL 300 s with maximum 900 s; `maxPayloadBytes` 16384; `maxJsonDepth` 8; `hookTimeoutMs` 2000; validated as positive integers
- [ ] T116 [US6] Create `packages/security/src/limits/limiter.ts`: orchestrates buckets (`turn:`, `user:`, `tenant`, `cap:`, `risk:`, `deny:`); a per-replica local per-turn pre-check (a local count never exceeds the shared count, so a local rejection is always correct); runner-supplied depth and wall-clock checks; any limiter error yields a denial (depends on T114, T115)
- [ ] T117 [US6] Create stages `packages/security/src/gateway/stages/rate-limit.ts` (stage 2) and `stages/replay.ts` (stage 3: claim `${aiSessionId}:${callId}` with 86400 s retention BEFORE validation, so a corrected resubmission with the same `callId` is a replay); add the per-capability and HIGH+CRITICAL limit checks to the authorize stage; record every denial toward the throttle; emit `AI_RATE_LIMITED`; wire into `pipeline.ts` (depends on T116)
- [ ] T118 [P] [US6] Create `packages/security/src/state/postgres/purge.ts` deleting expired replay claims and rate counters, with a test, for a scheduled job
- [ ] T119 [US6] Make T107-T109 pass (`tests/security/replay.test.ts`, `tests/security/rate-abuse.test.ts`, and the conformance suites under `packages/security/src/state/conformance/`) and confirm the checkpoint: 10,000 proposals in one turn produce at most 8 executions

**Checkpoint**: User Story 6 works independently of US7.

---

## Phase 9: User Story 7 - Reusable security test infrastructure (Priority: P2)

**Goal**: A developer who adds a capability gets a ready-made way to attack it, and a coverage report shows
whether every applicable scenario has been tested.

**Independent Test**: Add a sample capability, run the catalogue, then omit a required scenario and confirm the
quality gate fails and names the gap (spec US7). Covers FR-045..FR-049, SC-010, SC-011, SC-012.

### Tests for User Story 7 ⚠️ (write first, confirm they FAIL)

- [ ] T120 [P] [US7] Write `packages/testkit/src/coverage.test.ts`: `buildCoverageReport` marks cells `covered`, `not-applicable` (from capability traits), `waived` (needs justification and reviewer), and `MISSING`; the CLI exits non-zero on any `MISSING` and names the `actionId` and scenario id (SC-011)
- [ ] T121 [P] [US7] Write `tests/security/determinism.test.ts` and `scripts/determinism-check.mjs`: two consecutive full runs produce identical results, and the run makes no network access (SC-012)

### Implementation for User Story 7

- [ ] T122 [P] [US7] Create `packages/testkit/src/hostile-planner.ts`: `HostilePlanner` implementing `PlannerPort` from a script of `ProposalCall` values, with no LLM
- [ ] T123 [P] [US7] Create `packages/testkit/src/attacks/dependency-failure.ts`: ATK-DEP matrix generated over 9 ports (authentication, permissions, resources, pages, replay, rate limiter, confirmations store, tenant policy, audit append) x 4 failure modes (36 cases), with the documented exception for the confirmation channel
- [ ] T124 [P] [US7] Create `packages/testkit/src/attacks/cross-tenant-store.ts`: ATK-XTENANT-05 as role `dap_app` over every `sec_*` table (tenant A setting, no setting, write for tenant B) and ATK-XTENANT-10 canary resource names
- [ ] T125 [P] [US7] Create `packages/testkit/src/oracle.ts` (independent oracle recomputing whether a call may reach an executor, without calling Gateway logic) and `tests/security/invariants.test.ts` with the four fast-check properties from the catalogue
- [ ] T126 [US7] Create `packages/testkit/src/attacks/index.ts`: catalogue registry of every scenario with `appliesTo(traits)` per the catalogue "Applicability traits" table, the entry point `runCatalogue(capability)` for future capabilities, and `tests/security/catalogue.test.ts` running all scenarios against all six test capabilities (depends on T052-T054, T072-T073, T081-T083, T096, T107-T108, T123-T124)
- [ ] T127 [US7] Create `packages/testkit/src/coverage.ts` (`buildCoverageReport`), `packages/testkit/waivers.json` (standing ATK-HIDDEN waiver for this feature), and the CLI `packages/testkit/src/cli/coverage.ts` bound to `npm run coverage:security` (depends on T126)
- [ ] T128 [P] [US7] Create `stryker.config.mjs` for mutation testing of `packages/security` and `.github/workflows/nightly.yml` running it nightly; surviving mutants in a security check count as a missing test
- [ ] T129 [P] [US7] Create `packages/testkit/README.md`: how to run the catalogue against a new capability, how to add a waiver, and how to read the coverage report (the contract for later features, FR-053)
- [ ] T130 [US7] Make `packages/testkit/src/coverage.test.ts` and `tests/security/determinism.test.ts` (T120-T121) pass; run `npm run test:security` and `npm run coverage:security` and confirm both exit 0

**Checkpoint**: All user stories are independently functional.

---

## Phase 10: Delivery, Polish & Cross-Cutting Concerns

**Purpose**: Thin reference host, containers, observability, CI, and the final validation. This phase
also serves the constitution's workflow gates (Section 3).

- [ ] T131 [P] Create `apps/reference-host/src/compose.ts` (composition root: registry from the test capabilities, `bindExecutors`, PostgreSQL state store, audit, `createPolicyGateway`; hands ONLY `proposals.forSession(...)` to `@dap/ai`) and `apps/reference-host/src/config.ts` (validated environment: database URLs, global allowlist, limits)
- [ ] T132 [P] Create `apps/reference-host/src/dev-auth/` stub `AuthenticationPort` (sessions from environment value `DEV_SESSIONS`) that refuses to start when `NODE_ENV=production` or without `DAP_ALLOW_DEV_AUTH=1`, with a test
- [ ] T133 [P] Create `apps/reference-host/src/http/confirmations.ts`: `GET /confirmations/pending` and `POST /confirmations/{id}/decision` per `contracts/reference-host-api.md` (same-origin `Origin` check plus a custom header; the body names no user or tenant; statuses 200, 409, 401, 400)
- [ ] T134 [P] Create `apps/reference-host/src/http/dev-hostile-run.ts`: `POST /dev/hostile-run` running a catalogue scenario through a bound submitter, enabled only with `DAP_ENABLE_DEV_ROUTES=1` and refused in production
- [ ] T135 [P] Create `apps/reference-host/src/http/ops.ts` (`/healthz`, `/readyz` returning 503 unless the state store `ping` and the audit sink both succeed, `/metrics`), `apps/reference-host/src/metrics.ts` (series from research D18 implementing `GatewayTelemetry`, no tenant or user labels), and `apps/reference-host/src/logging.ts` (pino with redaction)
- [ ] T136 Write `tests/integration/confirmation-flow.test.ts`, `tests/integration/readiness-fail-closed.test.ts` (stop PostgreSQL: `/readyz` is 503 and every proposal is `DENIED` with `try_later`), and `tests/integration/http-security.test.ts` (decision route without a session returns 401; no AI-layer path reaches `decide`) (depends on T131-T135)
- [ ] T137 [P] Create `deploy/docker/Dockerfile` (multi-stage; dependency manifests installed before source copy for layer caching; non-root runtime user; no secrets in the image) and extend `deploy/compose.yaml` with the host, Prometheus, and Grafana services
- [ ] T138 [P] Create `deploy/prometheus/prometheus.yml` with alert rules (denial spike, any audit write failure, policy-violation spike) and `deploy/grafana/dashboard.json` with at least three panels
- [ ] T139 [P] Create `deploy/k8s/deployment.yaml` (2 or more replicas, readiness probe on `/readyz`, secrets by reference) and `deploy/k8s/service.yaml`; validate on Minikube including a deleted-pod self-healing check
- [ ] T140 Extend `.github/workflows/ci.yml` with a PostgreSQL service container, `test:conformance`, `test:security`, `coverage:security`, `npm audit --audit-level=high`, gitleaks secret scanning, and the container build; add `.github/dependabot.yml`
- [ ] T141 [P] Create `.github/pull_request_template.md`: constitution compliance checklist, capability-PR checklist (registry entry, schema, risk, permission, audit behavior, security tests, threat-model delta), and an AI-assistance disclosure section
- [ ] T142 [P] Create `docs/architecture.md`: trust-boundary diagram, the AI-to-action and confirmation-to-execution data flows, and the remaining-risks list from plan.md
- [ ] T143 Reconcile `specs/001-ai-security-foundation/contracts/*.ts` with the implemented package exports (types in `@dap/contracts`, runtime in `@dap/security`) and re-run the strict compile check
- [ ] T144 Run `quickstart.md` end to end and record results in `docs/validation-report.md`, showing a passing automated check for each of SC-001 through SC-012
- [ ] T145 Final review recorded in `docs/constitution-review.md`: walk constitution Principles I-XVII with evidence, list known limitations and remaining risks (plan.md "Remaining Risks"), make no claim that the system is "secure", and obtain maintainer sign-off (the Phase 1 gate)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup; BLOCKS every user story
- **US2 (Phase 3)** depends on Foundational. **US1 (Phase 4)** depends on US2 (the Gateway consumes the registry).
  **US3 (Phase 5)** depends on US1 (it adds a pipeline stage). **US4 (Phase 6)** depends on US1 and US3.
- **US5 (Phase 7)** depends on US4 (it reuses the allow-event, grant, and execute path). **US6 (Phase 8)** depends on US4
  (rate-limit and replay stages join the pipeline). **US7 (Phase 9)** depends on the scenario files from US1-US6.
- **Delivery (Phase 10)** depends on US1-US6; T136 and T144 need the stories they exercise.

### Story completion order

```text
Setup -> Foundational -> US2 -> US1 -> US3 -> US4 ----> US5
                                                  \---> US6   (US5 and US6 can run in parallel)
                              US7 (testkit hardening) after US5 and US6 scenario files exist
                              Delivery after US4 (host needs a working Gateway); full validation after US7
```

### Within Each User Story

- Tests first, and they must FAIL before the implementation
- Contracts and conformance suites before adapters; adapters before stages; stages before wiring
- Migration before its PostgreSQL adapter; PostgreSQL adapter before its conformance run
- A story ends at its checkpoint, with the recording executor still at zero calls for every denial scenario

### Parallel Opportunities

- Setup T002-T011 after T001; skeleton tasks T003-T007 are all `[P]`
- Foundational: T013-T017 together; T019 and T021 together; T023, T024, T027-T033 together
- Each story's test tasks together, then its `[P]` implementation tasks (different files)
- After US4: US5 and US6 by different people; Delivery host tasks T131-T135 together

## Parallel Example: User Story 1

```bash
# Tests for User Story 1 together:
Task: "Create attacks/unknown-action.ts and tests/security/unknown-action.test.ts"        # T052
Task: "Create attacks/malformed-parameters.ts and tests/security/malformed-parameters.test.ts"  # T053
Task: "Write validation/strict-json.test.ts (duplicate keys, prototype keys, caps)"       # T055
Task: "Write gateway/feedback.test.ts (D14 mapping, byte-identical not-available)"        # T057
Task: "Write tests/architecture/graph.test.ts and static-scan.test.ts"                    # T059, T060

# Independent implementation files together:
Task: "Create validation/strict-json.ts"      # T061
Task: "Create validation/envelope.ts"         # T062
Task: "Create gateway/hook-wrapper.ts"        # T065
Task: "Create ai/planner-port.ts and tool-call.ts"  # T069
```

## Implementation Strategy

### MVP First (the complete boundary: all four P1 stories)

1. Phase 1 Setup, then Phase 2 Foundational
2. Phase 3 (US2), Phase 4 (US1): **first demo**: the boundary fails closed; every hostile request is denied
3. Phase 5 (US3), Phase 6 (US4): identity, tenant, permissions, and durable audit; the first allowed execution (POS-01)
4. **STOP and VALIDATE**: run `npm run test:security`; every denial scenario leaves the executor at zero calls and POS-01 executes exactly once

US1 alone is not a usable MVP of the whole feature: until US3 and US4 land, nothing can be allowed.
It is, however, a safe stopping point, because the default state is "deny everything".

### Incremental Delivery

1. Foundation, then US2, US1: demonstrable fail-closed boundary
2. Add US3, US4: complete P1 boundary (MVP)
3. Add US5 (confirmations) and US6 (limits and replay) in parallel
4. Add US7 (coverage gate, determinism, property suites), then Delivery assets
5. Each story keeps the earlier stories' scenarios green

### Parallel Team Strategy

After Foundational: one person on US2 then US1; once the Gateway skeleton (T068) exists, a second person can
start the PostgreSQL migrations and adapters (T093, T102, T112, T113) because they need only the ports.

## Traceability: requested task list to this file

Your 20 items are all covered. IDs differ because the format requires sequential numbering in execution order.

| Requested | Item | Covered by |
|-----------|------|------------|
| T001 | Define RiskLevel | T013 |
| T002 | Define ActionDefinition schema | T014, T042 (schema rules), T044 |
| T003 | Implement ActionRegistry | T044, T045, T050 |
| T004 | Implement validation layer | T061, T062, T063 (with T055, T056) |
| T005 | Implement PolicyGateway | T066, T067, T068 |
| T006 | Add authorization context | T020 (minting), T076, T077 |
| T007 | Enforce default-deny | T050, T058, T065, T067 |
| T008 | Reject unknown actions | T067 (resolve stage), T052 |
| T009 | Confirmation tokens | T104 (random handle; no separate secret per research D10) |
| T010 | Bind confirmation to action/resource/user | T100, T098 |
| T011 | Expiration | T100 (TTL rule), T102, T103 (database-clock expiry) |
| T012 | Replay prevention | T103 (single-use confirmations), T114, T117 (proposal replay) |
| T013 | Audit event model | T017, T079, T086 |
| T014 | Denied action logging | T088, T089 |
| T015 | Allowed action logging | T089, T090 |
| T016 | Unknown action attack | T052 |
| T017 | Privilege escalation | T072 |
| T018 | Tenant escape | T073, T124 |
| T019 | Confirmation bypass | T096 |
| T020 | Malformed action arguments | T053, T055, T056 |

## Notes

- `[P]` tasks touch different files and have no dependency on an incomplete task
- `[USn]` labels map each task to its spec story; Setup, Foundational, and Delivery tasks carry none
- Security tests are distributed into each story (Principle XVII) instead of a trailing phase, so a control and its
  proof always land together; the full catalogue is assembled and gated in US7
- Verify tests fail before implementing; commit after each task or logical group (the repo is not yet under git)
- Never weaken, skip, or delete a security test to make a build pass (constitution Principle XVII)
