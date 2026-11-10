import type { Bootstrap } from "../types";

/** UI status only. The server still authorizes and commits every business command. */
export function assignmentAvailability(bootstrap: Pick<Bootstrap, "mode" | "writes_enabled" | "capabilities">) {
 const reasons: string[] = [];
 if (!bootstrap.capabilities.assign) reasons.push("Your account has dashboard read access, but needs a Department Assignor or Global Assignor work role to assign tasks.");
  const writesReady = bootstrap.writes_enabled === true;
  if (!writesReady) reasons.push("Task saving is not enabled for this account.");
 return { canSave: bootstrap.capabilities.assign && writesReady, reasons };
}
