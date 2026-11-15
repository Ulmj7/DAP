/**
 * @dap/testkit: coverage.ts (T120, T127): the coverage report of FR-048 / SC-011.
 *
 * Every (capability, scenario) cell is exactly one of covered, not-applicable, waived or MISSING, and any MISSING cell fails the gate. Nothing in
 * this module runs a scenario or reads a clock: the evidence (`executedScenarioIds`) and the waivers come in as data, the scenario list and the
 * traits are derived from the code (`discoverScenarios`, `traitsOf`), and bad input throws instead of producing a report that looks complete.
 */
import type { ActionDefinition, AttackScenario, CapabilityTraits, CoverageCell, CoverageReport, RiskLevel, Waiver } from "@dap/contracts";

/** Waiver `actionId` meaning "every capability": the standing waiver of a reserved scenario. */
export const ANY_CAPABILITY = "*";
const EPOCH = "1970-01-01T00:00:00.000Z";

/** Bad input to the coverage report: a malformed or stale waiver, evidence for something unknown, an empty universe. Never a missing cell. */
export class CoverageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageInputError";
  }
}

const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim().length === 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nullPrototype = <T>(): { [key: string]: T } => Object.create(null) as { [key: string]: T };

/** The traits that decide which scenarios apply, read from the definition and nowhere else. */
export function traitsOf(definition: Pick<ActionDefinition<never>, "id" | "risk" | "changesState" | "confirmation"> & { readonly resource?: unknown }): CapabilityTraits {
  return Object.freeze({
    actionId: definition.id as string,
    risk: definition.risk,
    changesState: definition.changesState,
    targetsResource: typeof definition.resource === "function",
    requiresConfirmation: definition.confirmation.kind === "required",
  });
}

const looksLikeScenario = (value: unknown): value is AttackScenario => isRecord(value) && typeof value["id"] === "string" && /^ATK-/.test(value["id"]) &&
  typeof value["appliesTo"] === "function" && typeof value["run"] === "function" && typeof value["verify"] === "function";

/**
 * Every attack scenario exported by the given module namespace: each export that is a array made only of scenarios. A scenario added
 * to any attack module that the barrel exports reaches the report without a list being edited here.
 */
export function discoverScenarios(moduleExports: Readonly<Record<string, unknown>>): readonly AttackScenario[] {
  const byId = new Map<string, AttackScenario>();
  for (const value of Object.values(moduleExports)) {
    if (!Array.isArray(value) || !value.every(looksLikeScenario)) continue;
    for (const item of value as readonly AttackScenario[]) {
      const known = byId.get(item.id);
      if (known !== undefined && known !== item) throw new CoverageInputError(`duplicate scenario id ${item.id} exported by two different scenarios`);
      byId.set(item.id, item);
    }
  }
  return Object.freeze([...byId.values()]);
}

/** What ran and passed, as (actionId, scenarioId) pairs; the file form is what the CLI reads. */
export class ExecutionLedger {
  readonly #pairs = new Map<string, Set<string>>();

  record(actionId: string, scenarioId: string): void {
    if (isBlank(actionId) || isBlank(scenarioId)) throw new CoverageInputError("a ledger entry needs an action id and a scenario id");
    const ids = this.#pairs.get(actionId) ?? new Set<string>();
    ids.add(scenarioId);
    this.#pairs.set(actionId, ids);
  }

  toMap(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map([...this.#pairs].map(([actionId, ids]) => [actionId, new Set(ids)]));
  }

  /** Sorted, so that two runs that did the same work write the same bytes. */
  serialize(): string {
    const executed = nullPrototype<string[]>();
    for (const actionId of [...this.#pairs.keys()].sort()) executed[actionId] = [...this.#pairs.get(actionId)!].sort();
    return `${JSON.stringify({ executed }, null, 2)}\n`;
  }

  static parse(text: string): ExecutionLedger {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new CoverageInputError("the evidence file is not valid JSON"); }
    if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value["executed"])) throw new CoverageInputError('the evidence file must be {"executed": {actionId: [scenarioId]}}');
    const ledger = new ExecutionLedger();
    for (const [actionId, ids] of Object.entries(value["executed"])) {
      if (!Array.isArray(ids)) throw new CoverageInputError(`the evidence for ${actionId} must be an array of scenario ids`);
      for (const id of ids) {
        ledger.record(actionId, id);
      }
    }
    return ledger;
  }
}

const WAIVER_KEYS = ["actionId", "scenarioId", "justification", "reviewedBy"] as const;

/** Reads `waivers.json`: `{"waivers": [{actionId, scenarioId, justification, reviewedBy}]}` and nothing else. */
export function parseWaivers(text: string): readonly Waiver[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CoverageInputError("the waivers file is not valid JSON"); }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value["waivers"])) throw new CoverageInputError('the waivers file must be {"waivers": [...]}');
  return Object.freeze((value["waivers"] as unknown[]).map((entry, index): Waiver => {
    if (!isRecord(entry)) throw new CoverageInputError(`waiver ${index} is not an object`);
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== [...WAIVER_KEYS].sort().join(",")) throw new CoverageInputError(`waiver ${index} must have exactly ${WAIVER_KEYS.join(", ")}`);
    for (const key of WAIVER_KEYS) if (typeof entry[key] !== "string") throw new CoverageInputError(`waiver ${index}: ${key} must be a string`);
    return Object.freeze({ actionId: entry["actionId"] as string, scenarioId: entry["scenarioId"] as string, justification: entry["justification"] as string, reviewedBy: entry["reviewedBy"] as string });
  }));
}

function appliesTo(scenario: AttackScenario, traits: CapabilityTraits): boolean {
  let answer: unknown;
  try { answer = scenario.appliesTo(traits); } catch { throw new CoverageInputError(`appliesTo of ${scenario.id} threw for ${traits.actionId}`); }
  if (typeof answer !== "boolean") throw new CoverageInputError(`appliesTo of ${scenario.id} did not answer a boolean for ${traits.actionId}`);
  return answer;
}

/**
 * Builds the matrix. `executedScenarioIds` is evidence that a scenario RAN AND PASSED for a capability. Order of decision per cell: the scenario does
 * not apply, so not-applicable; it ran, so covered; a waiver names the cell (or every capability), so waived; otherwise MISSING.
 */
export function buildCoverageReport(args: {
  readonly capabilities: readonly CapabilityTraits[];
  readonly scenarios: readonly AttackScenario[];
  readonly executedScenarioIds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waivers: readonly Waiver[];
  /** Supplied by the caller so that the builder reads no clock; the Unix epoch when absent. */
  readonly generatedAt?: string;
}): CoverageReport {
  const { capabilities, scenarios, executedScenarioIds, waivers } = args;
  if (capabilities.length === 0) throw new CoverageInputError("no capabilities: an empty report would pass vacuously");
  if (scenarios.length === 0) throw new CoverageInputError("no scenarios: an empty report would pass vacuously");
  const actionIds = new Set<string>();
  for (const capability of capabilities) {
    if (isBlank(capability.actionId)) throw new CoverageInputError("a capability has no action id");
    if (actionIds.has(capability.actionId)) throw new CoverageInputError(`duplicate capability ${capability.actionId}`);
    actionIds.add(capability.actionId);
  }
  const byScenario = new Map<string, AttackScenario>();
  for (const scenario of scenarios) {
    if (isBlank(scenario.id)) throw new CoverageInputError("a scenario has no scenario id");
    if (byScenario.has(scenario.id)) throw new CoverageInputError(`duplicate scenario ${scenario.id}`);
    byScenario.set(scenario.id, scenario);
  }
  for (const [actionId, ids] of executedScenarioIds) {
    if (!actionIds.has(actionId)) throw new CoverageInputError(`evidence for unknown capability ${actionId}`);
    for (const id of ids) if (!byScenario.has(id)) throw new CoverageInputError(`evidence for unknown scenario ${id} (capability ${actionId})`);
  }

  const waiverByCell = new Map<string, Waiver>();
  for (const waiver of waivers) {
    if (isBlank(waiver.actionId) || isBlank(waiver.scenarioId)) throw new CoverageInputError("a waiver needs an action id and a scenario id");
    const label = `waiver ${waiver.actionId}/${waiver.scenarioId}`;
    if (isBlank(waiver.justification)) throw new CoverageInputError(`${label} has no written justification`);
    if (isBlank(waiver.reviewedBy)) throw new CoverageInputError(`${label} has no reviewer`);
    const scenario = byScenario.get(waiver.scenarioId);
    if (scenario === undefined) throw new CoverageInputError(`${label} names an unknown scenario`);
    if (waiver.actionId !== ANY_CAPABILITY) {
      const capability = capabilities.find((item) => item.actionId === waiver.actionId);
      if (capability === undefined) throw new CoverageInputError(`${label} names an unknown capability`);
      if (!appliesTo(scenario, capability)) throw new CoverageInputError(`${label} excuses a scenario that does not apply to that capability`);
    }
    const key = `${waiver.actionId}\u0000${waiver.scenarioId}`;
    if (waiverByCell.has(key)) throw new CoverageInputError(`duplicate waiver ${waiver.actionId}/${waiver.scenarioId}`);
    waiverByCell.set(key, waiver);
  }

  const matrix = nullPrototype<{ [scenarioId: string]: CoverageCell }>();
  const missing: { actionId: string; scenarioId: string }[] = [];
  for (const capability of capabilities) {
    const row = nullPrototype<CoverageCell>();
    for (const scenario of scenarios) {
      let cell: CoverageCell;
      if (!appliesTo(scenario, capability)) cell = Object.freeze({ state: "not-applicable" as const });
      else if (executedScenarioIds.get(capability.actionId)?.has(scenario.id) === true) cell = Object.freeze({ state: "covered" as const });
      else {
        const waiver = waiverByCell.get(`${capability.actionId}\u0000${scenario.id}`) ?? waiverByCell.get(`${ANY_CAPABILITY}\u0000${scenario.id}`);
        if (waiver !== undefined) cell = Object.freeze({ state: "waived" as const, waiver });
        else {
          cell = Object.freeze({ state: "MISSING" as const });
          missing.push(Object.freeze({ actionId: capability.actionId, scenarioId: scenario.id }));
        }
      }
      row[scenario.id] = cell;
    }
    matrix[capability.actionId] = Object.freeze(row);
  }
  return Object.freeze({ generatedAt: args.generatedAt ?? EPOCH, matrix: Object.freeze(matrix), missing: Object.freeze(missing) });
}

/** One line per missing cell naming the capability and the scenario (SC-011); empty when nothing is missing. */
export function formatMissing(missing: CoverageReport["missing"]): string {
  return missing.map((cell) => `MISSING ${cell.actionId} ${cell.scenarioId}`).join("\n");
}

/** One row of the catalogue's "Applicability traits" table: which scenario ids it names and the trait that makes them apply. */
export interface ApplicabilityRow {
  readonly trait: string;
  matches(scenarioId: string): boolean;
  applies(traits: CapabilityTraits): boolean;
}

const BOOLEAN_TRAITS = ["changesState", "targetsResource", "requiresConfirmation"] as const;

function parseIdSpec(spec: string): (family: string, rest: string | undefined) => boolean {
  const [family, ...tail] = spec.split("-");
  const numbers = tail.join("-");
  if (family === undefined || !/^[A-Z]+$/.test(family)) throw new CoverageInputError(`applicability table: cannot read the scenario family in "${spec}"`);
  if (numbers === "" || numbers === "*") return (candidate) => candidate === family;
  const ranges = numbers.split("/").map((part) => {
    const match = /^(\d+)(?:\.\.(\d+))?$/.exec(part);
    if (!match) throw new CoverageInputError(`applicability table: cannot read "${part}" in "${spec}"`);
    return [Number(match[1]), Number(match[2] ?? match[1])] as const;
  });
  return (candidate, rest) => candidate === family && rest !== undefined && /^\d+$/.test(rest) && ranges.some(([low, high]) => Number(rest) >= low && Number(rest) <= high);
}

/** Reads the "Applicability traits" table out of the catalogue, so applicability is checked against the contract rather than a second list. */
export function parseApplicabilityTable(markdown: string): readonly ApplicabilityRow[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^##\s+Applicability traits\s*$/.test(line));
  if (start < 0) throw new CoverageInputError("the catalogue has no Applicability traits section");
  const rows: ApplicabilityRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("|")) { if (rows.length > 0) break; continue; }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 2 || /^-+$/.test(cells[0]!) || cells[0] === "Trait") continue;
    const trait = cells[0]!.replaceAll("`", "");
    const specs = cells[1]!.split(",").map((spec) => spec.trim().replaceAll("`", "")).filter((spec) => spec !== "");
    const matchers = specs.map((spec) => parseIdSpec(spec));
    let applies: (traits: CapabilityTraits) => boolean;
    if (trait === "every capability") applies = () => true;
    else if (trait.startsWith("risk ")) {
      const levels = trait.slice("risk ".length).split(" or ").map((level) => level.trim()) as RiskLevel[];
      applies = (traits) => levels.includes(traits.risk);
    } else if ((BOOLEAN_TRAITS as readonly string[]).includes(trait)) applies = (traits) => traits[trait as (typeof BOOLEAN_TRAITS)[number]];
    else throw new CoverageInputError(`applicability table: unknown trait "${trait}"`);
    rows.push({
      trait,
      matches(scenarioId) {
        const match = /^ATK-([A-Z]+)(?:-(.+))?$/.exec(scenarioId);
        if (!match) return false;
        return matchers.some((matcher) => matcher(match[1]!, match[2]));
      },
      applies,
    });
  }
  if (rows.length === 0) throw new CoverageInputError("the Applicability traits table has no rows");
  return Object.freeze(rows);
}
