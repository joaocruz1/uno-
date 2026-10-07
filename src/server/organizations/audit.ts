import { auditLogs, type UnoDatabase } from "@/db";

export type AuditWriter = Pick<UnoDatabase, "insert">;

export type AuditEntry = {
  organizationId: string | null;
  actorUserId: string;
  actorType?: "user" | "platform_admin";
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** IDs, roles, states and hashes only. Never tokens, PDFs or fiscal content. */
  changes?: Record<string, string | number | boolean | null>;
};

/** Writes the audit row in the caller's transaction so it commits or rolls back with the change. */
export async function writeAudit(writer: AuditWriter, entry: AuditEntry, now = new Date()): Promise<void> {
  await writer.insert(auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    actorType: entry.actorType ?? "user",
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    metadata: { result: "success", ...(entry.changes ? { changes: entry.changes } : {}) },
    createdAt: now,
  });
}
