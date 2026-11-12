# Quickstart: Validating the AI Security Foundation

**Feature**: `001-ai-security-foundation` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

A run-and-verify guide. It shows how to prove the feature works end to end once implemented. It
contains no implementation code; contracts are in [`contracts/`](./contracts/) and shapes in
[`data-model.md`](./data-model.md).

> **Status**: the npm scripts, compose file, and host below are **defined by this plan** and are
> created during implementation (`/speckit-tasks`, `/speckit-implement`). Nothing here runs yet.

## Prerequisites

- Node.js 22 and npm 10
- Docker (for PostgreSQL and the reference host)
- Free ports: 3000 (host), 5432 (PostgreSQL), 9090 (Prometheus), 3001 (Grafana)

## 1. Static gates: architecture and hygiene

```bash
npm ci
npm run lint          # includes: no eval/new Function, no restricted mint imports
npm run typecheck     # strict TypeScript across all packages
npm run test:arch     # import graph + workspace manifests + registry has no mutators
```

**Expected**: all pass. Introducing `import ... from "@dap/actions"` anywhere in `packages/ai`
makes `test:arch` fail naming the edge (**SC-001**, spec FR-011).

## 2. Unit and contract tests

```bash
npm test
```

**Expected**: registration rules R1-R12 each have a passing and a failing case; a plain `z.object`
schema is rejected; the Zod behavior pins (strict vs strip, input-mode `additionalProperties`,
bound keywords, duplicate-key behavior of `JSON.parse`) pass (**SC-002**, **SC-010**).

## 3. Shared state: both adapters behave identically

```bash
docker compose up -d postgres
npm run db:migrate
npm run test:conformance
```

**Expected**: the same conformance suite passes against the in-memory and the PostgreSQL adapters,
including 100 trials of two concurrent confirmation accepts where exactly one wins (**SC-005**).

## 4. The security attack suite (the core proof)

```bash
npm run test:security
```

Runs every scenario in [`contracts/security-test-catalogue.md`](./contracts/security-test-catalogue.md)
against test capabilities of all six risk classes, with no LLM and no network.

| Expected result | Success criterion |
|-----------------|-------------------|
| Every `ATK-*` scenario ends with the recording executor at 0 calls; every `POS-*` control executes exactly once | SC-001, SC-002 |
| Dependency failure matrix: all ports x all failure modes end in denial | SC-003 |
| Parity: AI path outcome equals direct-path outcome; cross-tenant feedback byte-identical to nonexistent | SC-004 |
| Expired, reused, mismatched, and fabricated confirmations rejected | SC-005 |
| 10,000 proposals in one turn execute at most the per-turn cap | SC-006 |
| One decision event per proposal; no execution when audit is down | SC-007 |
| Reviewer can answer the four audit questions from events alone | SC-008 |
| Leak scan finds no canary, stack trace, internal reason, or confirmation id | SC-009 |
| Property-based invariants hold over generated proposals | SC-001 |
| Two consecutive runs give identical results | SC-012 |

## 5. Coverage gate

```bash
npm run coverage:security
```

**Expected**: prints the capability-by-scenario matrix and exits 0 when every applicable cell is
`covered`, `not-applicable`, or `waived`. To see it fail, remove one scenario from a capability's
run list: the command exits non-zero and names the missing `actionId` and scenario id (**SC-011**).

## 6. Run the reference host and watch it fail closed

```bash
docker compose up -d        # host, postgres, prometheus, grafana
export DAP_ALLOW_DEV_AUTH=1 DAP_ENABLE_DEV_ROUTES=1     # development only
```

The dev stub maps a bearer value to a session (user and tenant) from its configuration. Examples
below assume two users in one tenant: `alice` and `bob`.

```bash
# Unknown action: INVALID_ACTION, nothing executes
curl -s -H "Authorization: Bearer alice" -H "Content-Type: application/json" \
  -d '{"scenario":"ATK-UNKNOWN-01"}' http://localhost:3000/dev/hostile-run

# Reserved dangerous name: FORBIDDEN_POLICY
curl -s -H "Authorization: Bearer alice" -H "Content-Type: application/json" \
  -d '{"scenario":"ATK-UNKNOWN-02"}' http://localhost:3000/dev/hostile-run
```

**Expected**: `{ "outcome": "INVALID_ACTION", "category": "not_available" }` and
`{ "outcome": "FORBIDDEN_POLICY", "category": "not_available" }`, with no internal reason and no
confirmation id anywhere in the body.

### Confirmation flow (HIGH risk test capability)

```bash
curl -s -H "Authorization: Bearer alice" -H "Content-Type: application/json" \
  -d '{"scenario":"POS-03-propose"}' http://localhost:3000/dev/hostile-run
# -> REQUIRES_CONFIRMATION, category needs_user_confirmation, no id in the body

curl -s -H "Authorization: Bearer alice" http://localhost:3000/confirmations/pending
# -> the consequence summary and the id, visible to alice's own session only

curl -s -X POST -H "Authorization: Bearer alice" -H "Origin: http://localhost:3000" \
  -H "X-DAP-CSRF: 1" -H "Content-Type: application/json" \
  -d '{"decision":"accept"}' http://localhost:3000/confirmations/<id>/decision
# -> { "status": "executed" }
```

**Expected**: repeating the last request returns `409 already_used`. The same request with
`Bearer bob` returns `409 not_found`. After the TTL, a fresh pending item returns `expired`.

### Replay and fail-closed readiness

- Submit the same `callId` twice through the dev route: the second is `DENIED/not_available`.
- `docker compose stop postgres`: `GET /readyz` returns `503`, and every proposal returns `DENIED`
  with category `try_later` (nothing executes).
- `curl -s localhost:3000/metrics`: shows decision counters by outcome and reason, no tenant or
  user labels.

## 7. Audit trail check

```bash
docker compose exec postgres psql -U dap_app -d dap \
  -c "select event_type, outcome, reason, action_id from sec_audit_events order by occurred_at limit 20;"
docker compose exec postgres psql -U dap_app -d dap -c "update sec_audit_events set reason='x';"
```

**Expected**: events appear as `AI_ACTION_PROPOSED` followed by exactly one decision event per
request. The `update` fails with a permission error (append-only), and a query with no tenant
setting returns no rows (row-level security).

## 8. CI: break it on purpose

Push a branch that removes one authorization check from the Gateway. **Expected**: the GitHub
Actions run goes red at `test:security` and names the failing scenarios. Restore it and the run
turns green. Optionally run `npm run test:mutation` (nightly in CI) to see mutation survivors in
`packages/security`; any surviving mutant in a check is a missing test.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `test:security` skips PostgreSQL scenarios | `docker compose up -d postgres` not running or migrations not applied |
| Host exits immediately at startup | A registration rule failed (the message lists every issue), or `NODE_ENV=production` with dev auth enabled |
| Every proposal returns `DENIED` | The global allowlist is empty (default deny). List the capability ids to enable them |
