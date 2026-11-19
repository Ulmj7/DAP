import { MAX_DESCRIPTION as MAX_TEXT, MAX_LABEL as MAX_TITLE } from "@dap/walkthrough";
import type { WaitKind } from "@dap/walkthrough";
import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { POSTCONDITION_NAMES } from "../../postconditions.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import type { AdminResult, GuideRecord } from "../client.js";
import { definitionToDraft, emptyStep, MAX_EDITOR_STEPS, validateDraft } from "../draft.js";
import type { DraftProblem } from "../draft.js";
import { getEditSession, newEditSession, setEditSession, takeRequestedEdit } from "../session.js";
import type { EditSession } from "../session.js";
import { adminPage, backLink, confirmPublish, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
export function editorPage(options: AdminPageOptions) {
  const { client, registry, signal } = options;
  const page = adminPage(c.editor);
  const notice = statusMessage();
  page.append(backLink(), notice);
  notice.textContent = c.loading;
  const requested = takeRequestedEdit();
  void client.list().then(async access => {
    if (signal.aborted) return;
    if (access.kind !== "ok") { notice.textContent = readError(access); return; }
    if (requested === undefined) {
      const session = getEditSession() ?? newEditSession();
      if (session.id && access.value.authored.some(row => row.id === session.id && row.status === "published")) {
        notice.textContent = c.readOnly;
      } else { notice.textContent = ""; renderEditor(page, notice, session, options); }
      return;
    }
    const current = getEditSession();
    if (current?.id === requested && current.saving) {
      notice.textContent = ""; renderEditor(page, notice, current, options); return;
    }
    setEditSession();
    const record = await client.get(requested);
    if (signal.aborted) return;
    if (record.kind !== "ok") { notice.textContent = readError(record); return; }
    if (record.value.status === "published") { notice.textContent = c.readOnly; return; }
    const draft = definitionToDraft(record.value.definition, registry);
    if (!draft) { notice.textContent = c.foreign; return; }
    const session = { id: record.value.id, draft, selected: 0, dirty: false };
    setEditSession(session); notice.textContent = ""; renderEditor(page, notice, session, options);
  });
  return page;
}

function renderEditor(page: HTMLElement, notice: HTMLElement, session: EditSession, options: AdminPageOptions) {
  const { client, registry, signal, preview, navigate, refresh } = options;
  const { draft } = session;
  const save = button(c.save, true);
  const showPreview = button(c.preview);
  const publish = button(c.publish);
  const errors = h("ul", { id: "editor-problems", class: "error" });
  const publishHint = h("p", { id: "editor-publish-hint", class: "hint" }, c.saveBeforePublish);
  for (const action of [save, showPreview]) action.setAttribute("aria-describedby", errors.id);
  publish.setAttribute("aria-describedby", `${errors.id} ${publishHint.id}`);
  const left = card();
  const right = card();
  const metadata = h("div");
  const inspector = h("div");
  right.append(metadata, inspector);
  page.append(h("div", { class: "admin-toolbar" }, h("div", { class: "admin-actions" }, save, showPreview, publish)), publishHint, errors,
    h("div", { class: "editor-panes" }, left, right));

  let busy = false;
  const fields = new Map<string, { control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; hint: HTMLElement }>();
  function field(name: string, label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, parent: HTMLElement) {
    control.id = `editor-${name}`;
    const hint = h("p", { id: `${control.id}-issue`, class: "error hint", hidden: true });
    control.setAttribute("aria-describedby", hint.id);
    fields.set(name, { control, hint });
    parent.append(h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint));
  }
  function input(name: "title" | "description" | "completion" | "text", label: string, value: string, set: (value: string) => void, parent: HTMLElement) {
    const control = (name === "title" ? h("input", { type: "text" }) : h("textarea", { rows: "2" })) as HTMLInputElement | HTMLTextAreaElement;
    control.maxLength = name === "title" ? MAX_TITLE : MAX_TEXT;
    control.value = value;
    field(name, label, control, parent);
    control.addEventListener("input", () => { if (!busy) { set(control.value); changed(); } });
  }
  const option = (value: string, text: string) => h("option", { value }, text);
  const select = () => h("select") as HTMLSelectElement;
  const stepLabel = (index: number) => `${c.step} ${index + 1}`;
  function canEdit() { return !busy && !signal.aborted; }
  function changed() {
    session.dirty = true; session.saved = false; notice.textContent = ""; update();
  }
  function stepControls(focus = false) {
    left.replaceChildren(h("h2", {}, c.steps));
    const list = h("ol", { class: "editor-steps" });
    let selected: HTMLButtonElement | undefined;
    const add = button(c.add);
    add.disabled = busy || draft.steps.length >= MAX_EDITOR_STEPS;
    add.addEventListener("click", () => {
      if (!canEdit() || add.disabled) return;
      draft.steps.push(emptyStep()); session.selected = draft.steps.length - 1; stepControls(true); changed();
    });
    draft.steps.forEach((_step, i) => {
      const pick = button(stepLabel(i));
      pick.setAttribute("aria-pressed", String(i === session.selected)); pick.disabled = busy;
      pick.addEventListener("click", () => {
        if (!canEdit()) return;
        session.selected = i; stepControls(true); update();
      });
      const actions = h("div", { class: "admin-actions" }, pick);
      if (i === session.selected) {
        selected = pick;
        const action = (label: string, disabled: boolean, run: () => void) => {
          const control = button(label); control.disabled = disabled || busy;
          control.setAttribute("aria-label", `${label}: ${stepLabel(i)}`);
          control.addEventListener("click", () => {
            if (!canEdit() || control.disabled) return;
            run(); stepControls(true); changed();
          });
          actions.append(control);
        };
        const move = (next: number) => { [draft.steps[i], draft.steps[next]] = [draft.steps[next]!, draft.steps[i]!]; session.selected = next; };
        action(c.up, i === 0, () => move(i - 1));
        action(c.down, i === draft.steps.length - 1, () => move(i + 1));
        action(c.remove, draft.steps.length <= 1, () => { draft.steps.splice(i, 1); session.selected = Math.min(i, draft.steps.length - 1); });
      }
      list.append(h("li", {}, actions));
    });
    left.append(list, add);
    renderInspector();
    if (focus) selected?.focus();
  }
  function renderInspector() {
    for (const name of ["target", "wait", "text", "verify"]) fields.delete(name);
    inspector.replaceChildren(h("h2", {}, stepLabel(session.selected)));
    const step = draft.steps[session.selected]!;
    const target = select();
    target.append(option("", c.problem.target));
    for (const route of registry.routes) {
      const group = h("optgroup", { label: copy.nav[route as keyof typeof copy.nav] ?? route });
      for (const item of registry.forRoute(route)) if (item.operations.includes("highlight")) group.append(option(item.id, item.label));
      if (group.childElementCount > 0) target.append(group);
    }
    target.value = step.target;
    field("target", c.target, target, inspector);
    const wait = select();
    if (step.wait === "") wait.append(option("", c.chooseWait));
    const operations = registry.get(step.target)?.operations;
    wait.append(option("ack", c.waits.ack));
    for (const kind of ["click", "input"] as const) if (operations?.includes(kind)) wait.append(option(kind, c.waits[kind]));
    wait.value = step.wait;
    field("wait", c.wait, wait, inspector);
    input("text", c.text, step.text, value => { step.text = value; }, inspector);
    const verify = select();
    verify.append(option("", c.none), ...POSTCONDITION_NAMES.map(name => option(name, c.checks[name])));
    verify.value = step.verify ?? "";
    field("verify", c.verify, verify, inspector);
    target.addEventListener("change", () => {
      if (!canEdit()) return;
      step.target = target.value;
      if (step.wait !== "" && step.wait !== "ack" && registry.get(step.target)?.operations.includes(step.wait) !== true) step.wait = "";
      renderInspector(); fields.get("target")?.control.focus(); changed();
    });
    wait.addEventListener("change", () => {
      if (!canEdit()) return;
      if ([...wait.options].some(item => item.value === wait.value)) step.wait = wait.value as WaitKind | "";
      changed();
    });
    verify.addEventListener("change", () => {
      if (!canEdit()) return;
      if (verify.value) step.verify = verify.value; else delete step.verify;
      changed();
    });
  }
  function update() {
    const validation = validateDraft(draft, registry, session.id);
    const problems: readonly DraftProblem[] = validation.ok ? [] : validation.problems;
    errors.replaceChildren(...problems.map(issue => h("li", {}, issue.step === undefined ? issue.message : `${stepLabel(issue.step)}: ${issue.message}`)));
    errors.hidden = validation.ok;
    for (const [name, { control, hint }] of fields) {
      const issue = problems.find(p => p.field === name && (p.step === undefined || p.step === session.selected));
      control.disabled = busy;
      if (issue) control.setAttribute("aria-invalid", "true"); else control.removeAttribute("aria-invalid");
      hint.textContent = issue?.message ?? "";
      hint.hidden = hint.textContent === "";
    }
    save.disabled = busy || !validation.ok;
    showPreview.disabled = busy || !validation.ok;
    publish.disabled = busy || !validation.ok || session.dirty || session.id === undefined;
    publishHint.hidden = !session.dirty && session.id !== undefined;
    return validation;
  }
  function setBusy(value: boolean) { busy = value; stepControls(); update(); }
  async function showSaving(pending: Promise<AdminResult<GuideRecord>>, restoreFocus: boolean) {
    setBusy(true); notice.textContent = c.saving;
    const result = await pending;
    if (signal.aborted) return;
    setBusy(false);
    notice.textContent = result.kind === "ok" ? c.saved : `${c.saveFailed}. ${writeError(result)}`;
    if (restoreFocus) save.focus();
  }
  save.addEventListener("click", () => {
    if (!canEdit() || save.disabled) return;
    const check = update();
    if (!check.ok) return;
    const id = session.id;
    // Keep the pending write with the model, so leaving and returning cannot create a second record.
    session.saving = (id === undefined ? client.create(check.definition) : client.update(id, check.definition)).then(result => {
      delete session.saving;
      if (result.kind === "ok") { session.id = result.value.id; session.dirty = false; session.saved = true; }
      return result;
    });
    void showSaving(session.saving, true);
  });
  showPreview.addEventListener("click", () => {
    if (!canEdit() || showPreview.disabled) return;
    const check = update();
    if (check.ok) preview(check.definition);
  });
  publish.addEventListener("click", () => {
    const id = session.id;
    if (!canEdit() || publish.disabled || id === undefined || session.dirty || !update().ok) return;
    confirmPublish(publish, page, () => {
      if (!canEdit() || session.dirty || !update().ok) return;
      setBusy(true); notice.textContent = c.saving;
      void client.setStatus(id, "published").then(result => {
        if (result.kind === "ok") {
          if (getEditSession() === session) setEditSession();
          if (!signal.aborted) navigate("walkthroughs");
          refresh(!signal.aborted);
        } else if (!signal.aborted) { setBusy(false); notice.textContent = writeError(result); publish.focus(); }
      });
    });
  });

  input("title", c.title, draft.title, value => { draft.title = value; }, metadata);
  input("description", c.description, draft.description, value => { draft.description = value; }, metadata);
  input("completion", c.completion, draft.completion, value => { draft.completion = value; }, metadata);
  if (session.saved) notice.textContent = c.saved;
  if (session.saving) void showSaving(session.saving, false);
  else { stepControls(); update(); }
}
