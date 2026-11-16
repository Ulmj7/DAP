/** @dap/walkthrough: pure core (no DOM). A leaf package: it imports no other @dap/* package. */
export { createSemanticRegistry, SemanticRegistryError, ID_PATTERN, MAX_LABEL, MAX_DESCRIPTION } from "./semantic/registry.js";
export { ROLES, OPERATIONS, PRIVACY_LEVELS } from "./semantic/types.js";
export type { SemanticElementDef, SemanticOperation, SemanticPrivacy, SemanticRegistry, SemanticRegistryInput, SemanticRole } from "./semantic/types.js";
export { ATTR_ID, ATTR_IGNORE, ATTR_PRIVATE, ATTR_REDACT, REDACTED_MARKER, buildSemanticContext, describeValue, effectivePrivacy } from "./privacy/privacy.js";
export type { EffectivePrivacy, ElementFacts, SemanticContext, SemanticContextElement, ValueView } from "./privacy/privacy.js";
