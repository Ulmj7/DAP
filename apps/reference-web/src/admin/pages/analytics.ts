import { copy } from "../../copy.js";
import { statusMessage } from "../../ui/pieces.js";
import { adminPage, readError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

export function analyticsPage({ client, signal }: AdminPageOptions) {
  const c = copy.admin;
  const page = adminPage(c.analytics);
  const status = statusMessage();
  status.textContent = c.loading;
  page.append(status);
  void client.list().then(result => {
    if (!signal.aborted) status.textContent = result.kind === "ok" ? c.analyticsPlaceholder : readError(result);
  });
  return page;
}
