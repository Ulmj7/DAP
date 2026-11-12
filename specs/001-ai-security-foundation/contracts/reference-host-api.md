# Reference Host: HTTP Contract

**Feature**: `001-ai-security-foundation` | **Non-production.** A thin service that exercises the
boundary over HTTP, gives the container and observability work something to deploy, and proves the
"two separate doors" rule (spec FR-030). A real host application replaces it.

Authentication is a **development-only stub** behind the `AuthenticationPort`. It must be enabled
explicitly (`DAP_ALLOW_DEV_AUTH=1`) and the process refuses to start when `NODE_ENV=production`.

## Confirmation endpoints (trusted human path)

Both require an authenticated user session. Neither is reachable from AI-layer code, and neither
accepts parameters: the stored, normalized parameters are what execute.

### `GET /confirmations/pending`

Lists the caller's own pending confirmations, tenant-scoped by the session.

```json
{ "items": [ { "id": "<uuid>", "actionId": "testHighPublish", "risk": "HIGH",
               "consequence": { "title": "...", "effects": ["..."], "irreversible": false },
               "expiresAt": "2026-11-13T04:40:00Z" } ] }
```

### `POST /confirmations/{id}/decision`

```json
{ "decision": "accept" }
```

| Result | HTTP | Body |
|--------|------|------|
| Executed | 200 | `{ "status": "executed" }` |
| Executed, but the action failed | 200 | `{ "status": "executed_with_failure" }` |
| Rejected | 200 | `{ "status": "rejected" }` |
| Not valid | 409 | `{ "status": "not_valid", "category": "not_found" or "expired" or "already_used" or "no_longer_allowed" }` |
| No valid session | 401 | `{ "error": "unauthenticated" }` |
| Malformed body | 400 | `{ "error": "invalid_request" }` |

Cross-site protection: requests must carry a same-origin `Origin` and a custom header, so they are
not simple cross-site requests. The deciding user is always the session's user; the body names no
user or tenant.

## Development-only route (disabled unless `DAP_ENABLE_DEV_ROUTES=1`; refused in production)

### `POST /dev/hostile-run`

Runs a catalogue scenario or a scripted list of proposals through a `ProposalSubmitter` bound to
the caller's session, then returns the `PlannerFeedback` list. It exists to demonstrate the
boundary and is never part of a deployed configuration.

```json
{ "scenario": "ATK-UNKNOWN-02" }
```

## Operations endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Process is up. Does not touch the state store |
| `GET /readyz` | `200` only if the state store `ping` and the audit sink both succeed; otherwise `503`. Fail-closed signal for orchestrators |
| `GET /metrics` | Prometheus text format. Series listed in research D18; no tenant or user labels. Bind to an internal interface only |

## What this host deliberately does not expose

No endpoint accepts a proposal from a browser. Proposals originate on the server (research D15).
No endpoint returns a confirmation id to anything but the owning user's session. No endpoint reads
audit events across tenants.
