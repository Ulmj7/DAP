import type { ActionRegistry, AnyActionDefinition } from "@dap/contracts";

/**
 * The registered definition for the action resolve authorized, proven to be that very action: same id, same version, same
 * definition hash. A registry that has since forgotten it, or answers with anything else, yields undefined (a dependency
 * failure for the caller), never a different definition. Each field is read exactly once, before any await.
 */
export function provenDefinition(get: ActionRegistry["get"], resolved: Readonly<Record<string, unknown>>): AnyActionDefinition | undefined {
  const entry = get(resolved.id as string);
  if (!entry || typeof entry !== "object") return undefined;
  const definition: unknown = Reflect.get(entry, "definition");
  const definitionHash: unknown = Reflect.get(entry, "definitionHash");
  if (!definition || typeof definition !== "object" || Reflect.get(definition, "id") !== resolved.id || Reflect.get(definition, "version") !== resolved.version || definitionHash !== resolved.definitionHash) return undefined;
  return definition as AnyActionDefinition;
}
