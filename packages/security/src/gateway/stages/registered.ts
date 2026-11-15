import type { ActionRegistry, AnyActionDefinition } from "@dap/contracts";

/** The only definition fields the stages after resolve use, each copied ONCE at the moment of proof. */
export type ProvenDefinition = Pick<AnyActionDefinition, "id" | "version" | "inputSchema" | "resource" | "requiredPermission" | "allowedPages" | "risk">;

/**
 * The registered definition for the action resolve authorized, proven to be that very action: same id, same version, same
 * definition hash. A registry that has since forgotten it, or answers with anything else, yields undefined (a dependency
 * failure for the caller), never a different definition.
 *
 * Every field is read exactly once, before any await, and the caller receives a frozen snapshot of those reads, never the
 * live object: a getter that answers differently the second time can neither pass the proof with one id and then be
 * validated, digested or authorized under another, nor swap the permission or pages between two stages.
 */
export function provenDefinition(get: ActionRegistry["get"], resolved: Readonly<Record<string, unknown>>): ProvenDefinition | undefined {
  const entry = get(resolved.id as string);
  if (!entry || typeof entry !== "object") return undefined;
  const definition: unknown = Reflect.get(entry, "definition");
  const definitionHash: unknown = Reflect.get(entry, "definitionHash");
  if (!definition || typeof definition !== "object") return undefined;
  const id: unknown = Reflect.get(definition, "id");
  const version: unknown = Reflect.get(definition, "version");
  if (id !== resolved.id || version !== resolved.version || definitionHash !== resolved.definitionHash) return undefined;
  return Object.freeze({
    id, version,
    risk: Reflect.get(definition, "risk"),
    inputSchema: Reflect.get(definition, "inputSchema"),
    resource: Reflect.get(definition, "resource"),
    requiredPermission: Reflect.get(definition, "requiredPermission"),
    allowedPages: Reflect.get(definition, "allowedPages"),
  }) as ProvenDefinition;
}
