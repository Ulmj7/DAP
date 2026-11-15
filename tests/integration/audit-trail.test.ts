/**
 * T084, SC-008. From the audit events ALONE a reviewer can answer, for a sample of 20 mixed actions: what was attempted, why it was
 * allowed or denied, who authorized it, and what resource changed. The same questions are answered, over the real chain with stand-ins
 * for the stages not built yet, by packages/security/src/gateway/audit-trail.test.ts; this file is the end-to-end version.
 */
import { describe, it } from "vitest";

describe("T084 audit trail (SC-008)", () => {
  it.todo("20 mixed proposals through the real gateway and the PostgreSQL audit store: every question answered from events alone (needs world.withGateway T070 and the Postgres sink T094)");
  it.todo("a reviewer in tenant A cannot answer anything about tenant B's actions from the events it can read (ATK-XTENANT-09, T094)");
});
