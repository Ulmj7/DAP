/**
 * The walkthrough store port (Feature 004, T404). Small on purpose: exactly the operations authoring needs, no generic repository.
 *
 * Trust: `scope` ({ tenantId, actor }) always comes from the trusted context of the caller (the Gateway's `call.security` for writes, the host-resolved principal for
 * reads), never from a request body or a parameter. The store re-checks the SHAPE of what it is given but does not validate walkthrough semantics: the executor
 * validates with the one Feature 002 validator before it calls `saveDraft`, and passes the same validator to `setStatus`, which runs it INSIDE the transaction on the
 * row it has locked, so a definition cannot change between "validated" and "published".
 */
import type { WalkthroughDef } from "@dap/walkthrough/authoring";
import type { WalkthroughStatus } from "./schema.js";

export const MAX_PUBLISHED_PER_TENANT = 50;
export const MAX_LISTED = 200;
export const MAX_DEFINITION_BYTES = 32 * 1024;

export interface Scope {
  /** From the trusted context. */
  readonly tenantId: string;
  /** The safe actor id from the trusted context (`call.security.userId`). */
  readonly actor: string;
}
export interface StoredSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: WalkthroughStatus;
  readonly stepCount: number;
  readonly updatedAt: string;
}
export interface StoredWalkthrough {
  readonly id: string;
  readonly status: WalkthroughStatus;
  /** The stored JSON, NOT yet trusted: every reader re-validates it against the current registry data. */
  readonly definition: unknown;
  readonly updatedAt: string;
}

export type SaveOutcome = "created" | "updated" | "not_a_draft" | "id_refused" | "too_large";
export type StatusOutcome = "changed" | "unchanged" | "not_found" | "invalid_definition" | "limit_reached" | "id_refused";

export interface WalkthroughStore {
  /** The tenant's authored guides (drafts and published), newest update first, at most 200. */
  list(tenantId: string): Promise<readonly StoredSummary[]>;
  get(tenantId: string, id: string): Promise<StoredWalkthrough | null>;
  /** Inserts a new draft, or updates an existing one ONLY while its status is `draft`. A published guide is never overwritten. */
  saveDraft(scope: Scope, id: string, definition: WalkthroughDef): Promise<SaveOutcome>;
  /**
   * Publish: locks the row, runs `isValid` on the STORED definition (re-validation against the current registry data), enforces the cap of 50 published per
   * tenant, then sets the status. Unpublish (`draft`) restores editability. Never creates a row.
   */
  setStatus(scope: Scope, id: string, status: WalkthroughStatus, isValid: (storedDefinition: unknown) => boolean): Promise<StatusOutcome>;
  /** The tenant's published guides, oldest first, at most 50. The definitions are untrusted JSON: re-validate each. */
  listPublished(tenantId: string): Promise<readonly StoredWalkthrough[]>;
}
