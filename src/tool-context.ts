import type { AuditIds } from "./audit.js";
import { getActiveServerName } from "./config.js";

export function auditIds(sessionId?: string, jobId?: string): AuditIds {
  const ids: AuditIds = {};
  const profileId = getActiveServerName();
  if (sessionId) ids.sessionId = sessionId;
  if (profileId) ids.profileId = profileId;
  if (jobId) ids.jobId = jobId;
  return ids;
}
