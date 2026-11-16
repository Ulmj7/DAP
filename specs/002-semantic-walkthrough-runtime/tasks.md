---

description: "Task list for the Semantic Walkthrough Runtime feature (002)"
---

# Tasks: Semantic Walkthrough Runtime

**Input**: [spec.md](./spec.md), [plan.md](./plan.md). No research/data-model/contracts documents: the types live in `plan.md` section 4 and in code.
**Base branch**: `dev`. Cut each batch from `dev`; merge with `--ff-only` into `dev`. `main` is reserved.
**Format**: `- [ ] T### [TIER] [P?] [Story?] Description (paths) - acceptance`. `[P]` = can run in parallel with the other `[P]` tasks of the same slice. Task IDs start at T201 so they never collide with Feature 001's T001-T146.
**Tiers (Constitution XIX)**: every open task is `[REQUIRED]`, `[OPTIONAL]` or `[FUTURE]`. Only REQUIRED tasks gate Feature 002. OPTIONAL is promoted only if a demo walkthrough needs it.
**Tests**: focused, representative, written with the code they cover. No catalogues, no mutation campaigns, no flood tests.
**QA**: three reviews, not one per slice: a focused review after Slice 1 (T207), one combined review for Slices 2-4 (T215), and a final review after Slice 5 (T223). Run the normal tests continuously; no mutation sweeps (plan section 8). Do not reopen Feature 001 unless a genuine Tier A defect appears; then fix only that, with a regression test.

**Open task counts (2026-11-16): REQUIRED 23, OPTIONAL 8, FUTURE 6.**

## Slice 1 - First visible walkthrough (goal: registered target -> highlight -> tooltip, visible in a browser)

- [ ] T201 [REQUIRED] Scaffold `packages/walkthrough` (`@dap/walkthrough`: `package.json` with exports `.` and `./dom` using the `@dap/source` condition, `tsconfig.json` with `lib: ES2023 + DOM`, `src/index.ts`, `src/dom/index.ts`), add it to the root `tsconfig.json` references, add Vitest project `dom` (jsdom; includes `packages/walkthrough/src/dom/**/*.test.ts` and `apps/reference-web/src/**/*.test.ts`) and exclude those paths from `unit`, add devDependency `jsdom`, add `test:walkthrough`. **Acceptance**: `npm run typecheck`, `npm test` and `npm run test:walkthrough` pass with one placeholder test per project.
- [ ] T202 [REQUIRED] [P] Boundary rules: in `dependency-cruiser.config.cjs` add `walkthrough-leaf` (`packages/walkthrough` may import no other workspace package), forbid `security|ai|actions|contracts` -> `walkthrough`, restrict `apps/reference-web` to `@dap/walkthrough`, extend `production-not-to-testkit` to both; add `tests/architecture/walkthrough-boundary.test.ts`: no `document|window|HTMLElement` in `packages/walkthrough/src` outside `src/dom`, no `eval|new Function|innerHTML|outerHTML|insertAdjacentHTML|document.write` in either new tree, no `fetch|XMLHttpRequest|WebSocket|import(` in `packages/walkthrough`, planted-failure proofs. **Acceptance**: `npm run check:deps` and the new arch test pass and fail on planted edges.
- [ ] T203 [REQUIRED] [P] [US4] Semantic registry: `src/semantic/{types,registry}.ts`, `createSemanticRegistry({ routes, elements })`, validation per plan 4.1 (duplicate/malformed id, unknown route, empty operations, bounds, markup characters), `Map` lookups, frozen result, `get/has/list/forRoute`. **Acceptance**: unit tests for valid registration and each rejection; unknown id lookup returns `undefined`, never throws.
- [ ] T204 [REQUIRED] [P] [US4] Privacy module (own module, own tests) `src/privacy/privacy.ts`: attribute-name constants, `effectivePrivacy(element-facts)` (ignore via element/ancestor, `type=password|hidden` always ignored), `describeValue` (`omitted | redacted | nonEmpty/empty`), `buildSemanticContext(registry, route, availability)` returning registry metadata + availability only. **Acceptance**: unit tests with ignored, private, redacted, password, hidden fixtures: no value, text or HTML ever appears in the output.
- [ ] T205 [REQUIRED] [P] [US1] DOM targets and overlay: `src/dom/targets.ts` (`find(id)` by exact attribute-string comparison over `querySelectorAll("[data-ai-id]")`, unique + visible + not ignored, `scrollIntoView` if off-screen, `observe` via MutationObserver), `src/dom/overlay.ts` (highlight ring + tooltip card, text via `textContent` only, "Got it" and "Cancel" controls, reposition on scroll/resize, `hide()` removes all nodes, `role="dialog"` and `aria-live` basics). **Acceptance**: jsdom tests for lookup, ignored/hidden/password targets absent, duplicate attribute value treated as unavailable, text rendered as text (a `<img onerror>` string stays inert), teardown leaves no nodes.
- [ ] T206 [REQUIRED] [P] [US1] Reference web app shell `apps/reference-web` (private workspace, Vite + vanilla TS, `vite.config.ts` with `resolve.conditions: ["@dap/source"]`, `index.html`, hash `router.ts`, observable `store.ts`, pages Dashboard / Profile / Settings with `data-ai-*` markup including one password field, one `data-ai-private` email, one `data-ai-ignore` panel, and `semantic-ui.ts` registering the demo elements: `nav.settings`, `nav.profile`, `profile.nameInput`, `profile.emailInput`, `profile.saveButton`, `settings.advancedToggle`, `settings.securityPanel`, `settings.twoFactorSetup`, `dashboard.createProjectButton`), scripts `dev:web` and `build:web`. **Acceptance**: `npm run dev:web` serves the three pages; `npm run build:web` succeeds; registry creation succeeds against the markup.
- [ ] T207 [REQUIRED] [US1] First visible demo: a "Show me" control on the Profile page that calls the overlay with `profile.nameInput` and a fixed tooltip, plus a jsdom test mounting the app. **Acceptance (Slice 1 demo)**: in the browser the name input is highlighted with a tooltip; asking for an unregistered ID highlights nothing; the test proves both. Focused QA pass for Slice 1 (privacy VI, no arbitrary selectors VII, leaf boundary, the demo).

## Slice 2 - Deterministic engine (goal: walkthrough definition -> engine state -> next steps, with fake ports)

- [ ] T208 [REQUIRED] [US5] Definitions and catalog: `src/walkthrough/{definition,catalog}.ts` (`Step` = `guide | navigate | complete`, `defineWalkthrough`, `createWalkthroughCatalog(registry, postconditionNames, defs)`) with every startup check in plan 4.3. **Acceptance**: unit tests for a valid catalog and for each rejection (duplicate walkthrough/step id, missing start/next/recover, unknown target/route/postcondition, operation mismatch, no path to `complete`, unreachable step); `catalog.list()` returns only id/title/description.
- [ ] T209 [REQUIRED] [US2] Pure state machine `src/engine/machine.ts`: states, inputs, effects, reason codes, `maxAttempts`, the transition table in plan 4.4. **Acceptance**: table-driven unit tests for every allowed transition; every other (state, input) pair is a no-op or a typed refusal; terminal states absorb inputs except `start`; `cancel` from any non-terminal state works.
- [ ] T210 [REQUIRED] [US2] Runtime shell and public API `src/engine/{ports,runtime}.ts` + `src/index.ts`: injected `targets`, `presenter`, `router`, `timers`, `postconditions`; effect runner; `startWalkthrough`, `cancel`, `getState`, `subscribe`, `catalog.list`, `context()` (through the privacy module). **Acceptance**: tests with fake ports run a walkthrough start -> complete without a DOM; unknown id and `busy` return typed refusals and never throw; cancel hides the overlay; subscribers see each state change once.

## Slice 3 - User interaction (goal: waitForClick / waitForInput -> typed semantic event -> deterministic advance)

- [ ] T211 [REQUIRED] [US2] Semantic events and DOM bridge: `src/engine/events.ts` (`parseSemanticEvent`: unknown shapes/ids dropped), `src/dom/bridge.ts` (delegated listeners for `click`, `change`, `hashchange`-fed route events, `closest("[data-ai-id]")`, registry `Map` lookup, privacy check, `trustedEventsOnly` default true, input events carry `nonEmpty` only). **Acceptance**: tests: correct click yields one event; click on another registered element yields that element's event (not the expected one); unregistered/ignored/password element yields nothing; synthetic event ignored by default and accepted only with the flag; no event ever contains a value.
- [ ] T212 [REQUIRED] [US2] Wait semantics: engine and runtime handling for `click`, `input`, `ack`, route waits; mismatched events leave state unchanged; target wait with `targetWaitMs` fed by `targetAvailable/targetGone`; one event is consumed by one step. **Acceptance**: tests: wrong click does not advance; unknown event does not advance; `input` advances only with `nonEmpty: true`; target appearing within the wait proceeds; target gone while waiting re-resolves; events during VERIFYING are ignored.
- [ ] T213 [REQUIRED] [US2] Internal navigation: `navigate` step through the `router` port, allowed routes = the registry's `routes` only, implicit route verification, hash router wiring in `apps/reference-web`. **Acceptance**: tests: navigating to an allowed route verifies and advances; a route outside the allowlist is refused with `navigation_refused` and nothing navigates; user-driven route change satisfies a route wait.

## Slice 4 - Verification and recovery (goal: postcondition -> success / recovery branch)

- [ ] T214 [REQUIRED] [US3] Postconditions: `verify` names resolved against the app-supplied map, success only on exactly `true`, async with a timeout (default 2000 ms via the timer port), throw/timeout/other value = failure. **Acceptance**: tests for true, false, truthy non-boolean, throw, rejection and timeout; a failed postcondition never advances.
- [ ] T215 [REQUIRED] [US3] Recovery: `recover` edge for failed postcondition and missing target, bounded attempts, reason codes (`target_unavailable`, `verification_failed`, `max_attempts`, `present_failed`, `navigation_refused`). **Acceptance**: tests: failed postcondition with `recover` returns to the recovery step and the original step again; missing target with `recover` takes it; no `recover` ends FAILED with the right reason; an endless retry loop ends at `maxAttempts`. Combined QA pass for Slices 2-4 (one review).

## Slice 5 - Reference product integration (goal: three demo walkthroughs -> integration proof -> docs)

- [ ] T216 [REQUIRED] [US5] Reference app behaviour: profile save with validation (name must be at least 2 characters; sets `profile.saved` and an error message otherwise), Settings "Advanced" toggle that reveals the security panel and an inert two-factor setup control (a demo control that changes nothing), `postconditions.ts` (`profile.saved`, `route.settings`, `route.profile`, `settings.advancedOpen`), all from structured store state. **Acceptance**: unit/jsdom tests of each page behaviour and postcondition; no postcondition reads DOM text.
- [ ] T217 [REQUIRED] [P] [US5] Walkthrough A `profileUpdate` (`src/walkthroughs/profileUpdate.ts`): navigate to Profile -> name input (wait `input`) -> Save (wait `click`, verify `profile.saved`) -> complete; recovery step on failed save returns to the name step with retry guidance. **Acceptance**: catalog accepts it; covered by T221.
- [ ] T218 [REQUIRED] [P] [US5] Walkthrough B `findSecuritySettings` (`src/walkthroughs/findSecuritySettings.ts`): from Dashboard highlight `nav.settings` (wait `click`, verify `route.settings`) -> highlight `settings.securityPanel` (wait `ack`) -> complete. **Acceptance**: catalog accepts it; covered by T221.
- [ ] T219 [REQUIRED] [P] [US5] Walkthrough C `findTwoFactorSettings` (`src/walkthroughs/findTwoFactorSettings.ts`): guidance only, it never changes an authentication setting. Target `settings.twoFactorSetup` is hidden -> `recover` to highlight `settings.advancedToggle` (wait `click`, verify `settings.advancedOpen`) -> retry the original step (highlight `settings.twoFactorSetup`, wait `ack`) -> complete. **Acceptance**: catalog accepts it; covered by T221.
- [ ] T220 [REQUIRED] [US5] Help launcher and progress UI (`src/launcher.ts`, mounted in the app shell): lists `catalog.list()`, start/cancel buttons, "Step n of N", completed / failed (with reason) / cancelled messages; narrow public API exported as the Feature 003 contract (`startWalkthrough`, `catalog`, `context`, `cancel`, `getState`, `subscribe`). **Acceptance**: launcher drives all three walkthroughs by hand in the browser; the API object exposes nothing else (type-level test).
- [ ] T221 [REQUIRED] [US5] Integration proof (jsdom, real app DOM + real runtime): A, B, C start -> complete through real DOM events; A failed-save recovery; C missing-target recovery; wrong click does not advance; unknown walkthrough refused; `context()` on Profile contains none of the password/private/redacted/ignored content; a synthetic event does not advance. **Acceptance**: this is the Definition-of-Done proof for FR-014 and SC-001..SC-004.
- [ ] T222 [REQUIRED] CI: extend `.github/workflows/ci.yml` with `npm run build:web` and `npm run test:walkthrough` (after the existing steps, before the M1 gate); keep every Feature 001 step and the M1 gate unchanged. **Acceptance**: workflow lints (`actionlint` locally), the same sequence passes locally on a fresh database, full `npm test` and the M1 gate stay at their Feature 001 baselines plus the new tests.
- [ ] T223 [REQUIRED] Short docs: `specs/002-semantic-walkthrough-runtime/quickstart.md` (run the demo; add a semantic element; add a walkthrough; the Feature 003 API; limits from Feature 001) and mark T201-T223 done with counts. **Acceptance**: a developer follows the quickstart verbatim and sees walkthrough A complete. **Manual real-browser smoke check (REQUIRED once, at closure)**: run `npm run dev:web` in a real browser and confirm for walkthroughs A, B and C that the highlight ring sits on the right element, the tooltip is readable and does not cover the target, scrolling and resizing keep them aligned, and clicking/typing feels responsive; record browser, date, pass/fail and notes in the quickstart. Then the final QA pass after Slice 5 (closure, one round).

## OPTIONAL (promote only if a demo needs it)

- [ ] T224 [OPTIONAL] Playwright real-browser smoke test of walkthrough A (+ CI step with browser install).
- [ ] T225 [OPTIONAL] Progress persistence across refresh (`sessionStorage`, step ID only).
- [ ] T226 [OPTIONAL] Overlay polish: placement flipping, arrow, transitions, themes.
- [ ] T227 [OPTIONAL] Fuller accessibility pass (focus management, keyboard Next/Esc beyond the basics, reduced motion).
- [ ] T228 [OPTIONAL] A fourth and fifth walkthrough; richer branch conditions.
- [ ] T229 [OPTIONAL] Per-element permission gating in the registry.
- [ ] T230 [OPTIONAL] Developer "what the AI sees" preview panel for `context()`.
- [ ] T231 [OPTIONAL] Poll-based postcondition waiting for slow asynchronous app state.

## FUTURE (explicitly not in Feature 002)

- [ ] T232 [FUTURE] AI-authored walkthrough definitions and any model-supplied selector or step.
- [ ] T233 [FUTURE] Self-healing selectors, vision/screenshot targeting.
- [ ] T234 [FUTURE] Browser extension, third-party sites and apps, iframes/shadow DOM.
- [ ] T235 [FUTURE] Multi-device progress sync, distributed runtime, generic workflow language, authoring dashboard, analytics.
- [ ] T236 [FUTURE] Server-to-browser transport and the Gateway capability `startWalkthrough` (Feature 003 owns it; initial risk class LOW, see plan section 6).
- [ ] T237 [FUTURE] Autonomous or high-risk runtime-initiated operations (must go through the Feature 001 Gateway and confirmation when pulled in).

## Dependencies and order

- T201 first. Then T202-T206 in parallel; T207 after T205 + T206.
- T208 after T203; T209 after T208; T210 after T209 + T204.
- T211 after T205 + T210; T212 after T211; T213 after T212.
- T214 after T213; T215 after T214.
- T216 after T206; T217-T219 in parallel after T216 + T215; T220 after T210; T221 after T217-T220; T222 after T221; T223 last.

## Definition of Done mapping

1 real UI: T206, T216 · 2 stable semantic IDs: T203, T206 · 3 deterministic resolution: T205 · 4 unknown targets fail safely: T203, T205, T207 · 5 privacy model: T204, T205, T221 · 6 definitions validate at startup: T208 · 7 explicit state machine: T209 · 8 highlight/instruction: T205, T207 · 9 wait for click: T211, T212 · 10 wait for input: T211, T212 · 11 wrong events do not advance: T211, T212, T221 · 12 deterministic postcondition: T214, T216 · 13 recovery demonstrated: T215, T217, T219 · 14 three walkthroughs end to end: T217-T221 · 15 full integration proof: T221 · 16 no LLM needed: T210, T221 · 17 no arbitrary selectors/JS/HTTP/SQL: T202, T203, T205 · 18 Feature 001 boundaries intact: T202, T222 · 19 CI green: T222 · 20 visibly demonstrable: T207, T220, T223.
