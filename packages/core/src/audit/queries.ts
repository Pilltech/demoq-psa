// Audit timeline for a record: who did what, on which channel. Spec: specs/kernel/audit.md
import { AuditTimelineInput } from "@demoq/shared";
import { defineQuery } from "../kernel";

export const auditTimeline = defineQuery({
  name: "audit.timeline",
  summary: "Who did what to a record, when and on which channel",
  permission: "audit.view",
  input: AuditTimelineInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, input) {
    const rows = await ctx.tx
      .selectFrom("audit_events")
      .select(["id", "occurred_at", "action", "actor_name", "actor_type", "channel", "outcome", "error_code", "mcp_client"])
      .where("subject_type", "=", input.subjectType)
      .where("subject_id", "=", input.subjectId)
      .orderBy("occurred_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit)
      .execute();
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  },
});
