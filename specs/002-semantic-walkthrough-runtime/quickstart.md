# Feature 002 quickstart: semantic walkthrough runtime and the reference web demo

Prerequisites: Node 22+ and npm. Run everything from the repository root. PostgreSQL (Docker) is needed **only** for the full test gates at the end; the demo and
every walkthrough test run without it.

```sh
npm ci
```

## 1. Run the demo

```sh
npm run dev:web
```

Open <http://127.0.0.1:5173/>. The app has three hash routes: `#/dashboard`, `#/profile`, `#/settings`. The Dashboard has a **Guides** card (and a **Guides**
link in the header) that lists the three guides. Nothing is sent to a server: the profile "save" is an in-memory service that takes about 250 ms.

| Guide id | Title | What you do | What the guide does, exactly |
| --- | --- | --- | --- |
| `profileUpdate` | Update your profile name | Press **Start guide** on the Dashboard. | Opens Profile and highlights **Display name**; waits for you to type. Then highlights **Save**; waits for your click. Success is declared only after the real save finishes (`profile.saved`). A name that fails validation (2 to 80 characters) or a failed save shows **Extra step** and sends you back to the name field; three failed Saves end in the "Let's try that again" dialog. Finishes with "Guide completed". |
| `findSecuritySettings` | Find the security settings | Press **Start guide**. | Opens Settings, highlights the **Security** panel and waits for **Got it**. It changes nothing. Finishes with "Guide completed". |
| `findTwoFactorSettings` | Find the two-factor authentication settings | Press **Start guide**. | Opens Settings. The two-factor control is hidden inside **Advanced**, so the guide shows **Extra step**, highlights **Advanced** and waits for your real click. When Advanced is open (verified) the original target is available, is highlighted and waits for **Got it**. It never enables or changes any authentication setting. If Advanced is already open there is no extra step. |

Everywhere: **Cancel** (or **Esc**) stops the guide, removes the ring, tooltip and dim layer, and shows "Guide cancelled". A walkthrough that is not in the catalog is refused
and a second start while one is running is refused ("busy"). Only your own (trusted) clicks and typing advance a guide; scripted events are ignored.

The demo page deliberately contains things a guide must never read: a private email field, a redacted phone number, an unregistered password field and an ignored
billing note. `runtime.context()` and every walkthrough ignore them (`T221` proves it in a real DOM).

## 2. Add a semantic element

1. Mark the element in the page code with `data-ai-id="<page>.<name>"` (and `data-ai-private`, `data-ai-redact` or `data-ai-ignore` when it must stay out of the model's sight).
2. Register it in `DEMO_ELEMENTS` in `apps/reference-web/src/semantic-ui.ts`: `id`, `route`, `role`, `label`, `description` (both from `src/copy.ts`), `operations`
   (`highlight`, `click`, `input`, `focus`) and `privacy`. An id that is not registered is never highlighted and never read; startup fails on a duplicate or malformed id, an unknown route or
   markup characters.

## 3. Add a walkthrough

1. Create `apps/reference-web/src/walkthroughs/<id>.ts` with `defineWalkthrough({ id, title, description, start, steps })`. Step kinds: `navigate` (allowed routes only), `guide` (a registered `target`,
   `wait: "click" | "input" | "ack"`, optional `verify` postcondition name and `recover` step) and `complete`. See `findTwoFactorSettings.ts` for a recovery edge.
2. Add it to `WALKTHROUGHS` in `apps/reference-web/src/walkthroughs/index.ts`. If it verifies something new, add the postcondition to `apps/reference-web/src/postconditions.ts`
   (`POSTCONDITION_NAMES` and the check; success only on exactly `true`).
3. The catalog is validated when the app mounts (`createWalkthroughCatalog` throws a `WalkthroughCatalogError` listing every problem, for example an unknown target or postcondition, a step that is unreachable
   from `start`, or a step with no path to a `complete` step).
4. If the new guide is something the AI Help is allowed to start, add its `{ id, title, description }` to `apps/reference-host/src/guidance/walkthrough-summaries.ts`. The parity test below fails until the
   two lists agree.

## 4. The Feature 003 API

The narrow object the host and the AI Help use is `mountApp(...).guides` (type `GuideApi` in `apps/reference-web/src/launcher.ts`): `startWalkthrough(id)`, `catalog.list()` (id, title, description only),
`context()`, `cancel()`, `getState()` and `subscribe()`. `startWalkthrough` returns `{ ok: true }` or `{ ok: false, reason: "unknown_walkthrough" | "busy" | "invalid_id" }`. There is no way to pass selectors,
scripts or steps through it.

The host (Feature 003) never imports `@dap/walkthrough` or the web app (`packages/ai` and `apps/reference-host` boundaries, enforced by `check:deps` and `tests/architecture`). It shows the model one static, frozen list
of safe summaries in `apps/reference-host/src/guidance/walkthrough-summaries.ts`. `tests/integration/walkthrough-summary-parity.test.ts` (T240) is the required guard that this list is exactly
`catalog.list()` of the real definitions: same ids, titles and descriptions, nothing missing, nothing invented.

## 5. Limits inherited from Feature 001

The runtime only ever acts on registered, public elements and sends typed semantic events, never raw DOM or field values. It has no arbitrary selector, no script, HTTP or SQL path and no
dependency on `security`, `actions`, `contracts` or `ai`. Guidance can only *start* a walkthrough by id; the Gateway still decides whether that start is allowed. No model or provider is needed to run or test any of this.

## 6. Tests and gates

Focused, no database:

```sh
npm run test:walkthrough         # packages/walkthrough + apps/reference-web + the boundary test (unit, jsdom, architecture)
npm run test:walkthrough:proof   # T221 end-to-end in a real DOM + T240 host summaries equal the real catalog (explicit files)
npm run lint && npm run typecheck && npm run check:deps
npm run build:web
```

Full gates (what CI runs; needs the PostgreSQL service of `deploy/compose.yaml`, as in `specs/003-ai-guidance/quickstart.md`):

```sh
docker compose -f deploy/compose.yaml up -d postgres
# create a throwaway database and the dap_owner / dap_app roles exactly as .github/workflows/ci.yml does, then:
export DAP_DATABASE_URL=postgresql://dap_app:dap_app_local_only@127.0.0.1:54329/dap
export DAP_MIGRATE_DATABASE_URL=postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54329/dap
npm run db:migrate
npm test
npm run test:m1-gate
```

CI (`.github/workflows/ci.yml`) runs, in order: install, lint, typecheck, dependency boundaries, architecture tests, migrations, security, conformance and integration tests, the reference-host vertical path, the full suite,
the guidance suite, then the Feature 002 steps (`test:walkthrough`, `test:walkthrough:proof`, `build:web`), then the M1 gate. No step needs a model provider, a browser download or the network beyond `npm ci`.

Local gate results, recorded 2026-11-18 on a fresh PostgreSQL 16 from `deploy/compose.yaml` (Linux, 16 CPUs, Docker default settings), CI order replayed step by step:

| Step | Result |
| --- | --- |
| lint, typecheck, dependency boundaries, architecture (9 files / 640 tests), migrations, security, integration (incl. reference-host vertical path), guidance, `test:walkthrough` (25 files / 711 tests; was 23 / 688 at the start of U3), `test:walkthrough:proof` (2 / 20), `build:web` | pass |
| `npm test`, conformance, `npm run test:m1-gate` | **fail on one test**, see below |

The one failure is `packages/security/src/state/conformance/state-postgres.test.ts` > RateLimiter conformance > "never loses concurrent hits: exactly the limit wins in each of 100 trials": `Test timed out in 5000ms`.
It is not caused by this feature: the same test fails the same way on the untouched baseline `e8257e6` (the M1 gate there: 1 failed, 2027 passed, 56 files; with Feature 002 U3: 1 failed, 2037 passed, 57 files, +1 file and +10 tests from the parity test).
It is a speed limit, not a wrong answer: with `--testTimeout=60000` it passes in about 10 s (64 concurrent hits x 100 trials, each a transaction under an advisory lock, about 1.5 ms per hit here). Turning off `synchronous_commit` did not help, and round trips to the database are 0.065 ms, so neither disk sync nor the network is the cause.
With only that timeout raised on the command line, `npm test` passes completely: 195 files / 6855 tests / 76 todo (baseline `e8257e6`: 192 / 6822 / 76, so +3 files and +33 tests). The gate runs its own vitest configuration and takes no timeout option, so it was not re-run green; nothing in it other than this test reported a problem.
No repository file was changed to work around this. Whether CI hardware is fast enough is not known from this machine.

Test honesty: jsdom cannot create trusted (`isTrusted`) clicks or typing, so the jsdom tests mount the app with `trustedEventsOnly: false` and dispatch real DOM events through the real bridge
(one test keeps the production default and proves scripted events are ignored). That the trusted-event path works is shown by the manual smoke below, where the app runs with its default.

## 7. Deferred (not built, not promised by this feature)

The full AI Help widget (C01, Feature 004), Records, a full Guide Library page, administrator authoring of walkthroughs, analytics UI, localisation beyond English, and any guide that changes data. The OPTIONAL and FUTURE
tasks in `tasks.md` stay open on purpose.

## 8. Manual real-browser smoke (T223) - recorded 2026-11-18

- **Browser**: Chromium 157.0.8103.38 (headless, `HeadlessChrome/157`), driven over the DevTools protocol (CDP) by `agent-browser`, against `npm run dev:web` (Vite dev server, app default `trustedEventsOnly: true`,
  so every advance below came from a trusted browser click or key press).
- **Viewports**: 1440 x 900 (desktop) and 390 x 844 (viewport emulation in desktop Chromium, not a real phone).
- **Result: PASS** for everything listed; no defect found.

| Check | 1440 | 390 |
| --- | --- | --- |
| `profileUpdate`: launcher lists the three guides and every launch button fits the width | pass | pass (buttons 139 x 44 px, no horizontal scroll) |
| Route changes to `#/profile`; ring sits on **Display name** (4 px halo around the field) | pass | pass |
| One-character name then Save: validation message, **Extra step** on the name field, no dialog, not completed | pass | not repeated |
| Valid name then Save: Save shows busy (`aria-disabled`), "Saving your profile…" about 250 ms, then "Your profile was saved." and the "Guide completed" dialog; overlay fully removed | pass | pass |
| `findSecuritySettings`: route changes, ring on the Security panel, "This guide changed nothing." | pass | pass |
| `findTwoFactorSettings`: Advanced collapsed, two-factor control not visible, **Extra step** on Advanced; real click opens it, control becomes available and is highlighted; no authentication claim | pass | pass |
| Ring stays on its target after a viewport resize and after scrolling (ring is exactly the target box plus 4 px) | pass | pass (scrolled automatically) |
| Tooltip stays inside the viewport and never covers the highlighted target | pass | pass (and re-checked at 320 x 568, 360 x 640, 667 x 375 and 640 x 360 after the QA fix, below) |
| Cancel button during the input step, and during the Save step: "Guide cancelled", ring, tooltip and dim layer gone; waited 1.8 s and typed more: nothing reappeared or advanced | pass | not repeated |
| Esc cancels a running guide; Esc closes the result dialog | pass | not repeated |
| No horizontal overflow on any page or step | pass | pass |
| Result dialog fully inside the viewport | pass | pass (dialog 358 px wide) |

Keyboard (real key presses): Enter on a focused launch button starts a guide; Esc cancels it; Tab reaches the page controls first and the tooltip's **Got it** and **Cancel** after them (they are last in the DOM);
**Got it** advances by Enter; the result dialog opens with **Done**/**Close** focused, and Enter or Esc closes it. After the dialog closes the focus lands on the page heading (the launcher left with the route change).
The launch button was focused with a script call and then activated with a real Enter key.
Observation, not a defect: focus is not moved into the tooltip when a step is shown; it stays where it was (usually the page body), so a keyboard user reaches **Got it** by tabbing past the page controls.

QA follow-up (U1+U2 review, 2026-11-18), both fixed in U3 and re-checked in the same Chromium over CDP:

- **Tooltip covering the highlighted field on small screens** (`packages/walkthrough/src/dom/placement.ts`): the phone placement now caps the card to the room left next to the control and scrolls the page (instant) when the control sits where the card is docked. Measured on the `profileUpdate` name step (ring = highlight box, card = tooltip): 320 x 568 card [8,8,304 x 290], ring top 310 (also after scrolling the page so the field sat under the card: the page moved by 48 px and the ring stayed clear); 667 x 375 card [8,8,651 x 290], ring [310 to 362]; 640 x 360 card capped to 280 px, ring [309 to 361] (its outer 4 px halo reaches 1 px past the bottom edge, the control itself is fully visible); 360 x 640 and 390 x 844 clear. No horizontal overflow at any of them. Unit coverage: every target position at eight phone sizes with the real 290 px card (`presentation.test.ts`).
- **Header Guides link**: it now scrolls the Guides card to the top and focuses its heading, from the Dashboard and from other pages (390 x 844: before, the card sat at y = 787 and the Start buttons were below the fold; after a real click, from Settings, and from Profile with a real Enter key, the three Start buttons are on screen and focus is on the **Guides** heading). `guides-link.test.ts`.

Not tested: viewports other than the ones listed, screen readers, real phones or other browsers, reduced-motion, high-contrast, a rapid Save-then-Cancel race in a real browser (covered in jsdom by `e2e.test.ts` and `event-order.test.ts`), and any WCAG conformance
claim. Console: only Vite dev-client debug lines. Screenshots were taken for review in the session scratchpad and are not committed.
