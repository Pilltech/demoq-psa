// MCP channel commands: the mcp.writes flag (D-MC-3) and deciding approvals from chat in two steps
// (prepare → confirm, plan §5.6). Spec: specs/channels/mcp-oauth.md (MCP-OA-13…16)
import { z } from "zod";
import { ApprovalDecideInput } from "@demoq/shared";
import {
  can,
  defineCommand,
  DomainError,
  notFoundIfMissing,
  randomToken,
  sha256,
  writeAudit,
  type Ctx,
  type Kernel,
  type UserActor,
} from "../kernel";
import {
  approvalDecide,
  approvalPolicy,
  DECIDE_IN_APP_KINDS,
  mayDecide,
  type ApprovalKind,
  type ApprovalRow,
  type ApprovalSnapshot,
  type Outcome,
} from "../approvals";

export const MCP_WRITES_KEY = "mcp.writes";
export const CONFIRM_TOKEN_PREFIX = "dq_mct_";
export const CONFIRM_TTL_MS = 5 * 60_000;
/** Where a person decides what MCP may not (INV-19). The adapter makes it absolute. */
export const inboxLink = (approvalId: string) => `/inbox?approval=${approvalId}`;

/** D-MC-3: are commands allowed over MCP at all? Off unless the settings row says true. */
export async function writesEnabled(kernel: Kernel): Promise<boolean> {
  const row = await kernel.db.selectFrom("settings").select("value").where("key", "=", MCP_WRITES_KEY).executeTakeFirst();
  return row?.value === true;
}

export const mcpSetWrites = defineCommand({
  name: "mcp.set_writes",
  summary: "Switch changing data from Claude (MCP writes) on or off for everyone",
  permission: "admin.config",
  input: z.object({ enabled: z.boolean() }),
  exposeTo: ["web"],
  async run(ctx, i) {
    await ctx.tx
      .insertInto("settings")
      .values({ key: MCP_WRITES_KEY, value: JSON.stringify(i.enabled) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(i.enabled) }))
      .execute();
    return { enabled: i.enabled };
  },
});

function me(ctx: Ctx): UserActor {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
  return ctx.actor;
}

/** The credential a confirm token is bound to: the OAuth grant, or pat:<id>. */
function credential(ctx: Ctx): string {
  if (ctx.channel !== "mcp" || !ctx.mcpGrantId) throw new DomainError("FORBIDDEN", { reason: "mcp_credential_required" });
  return ctx.mcpGrantId;
}

/** MCP-OA-09: deciding from chat needs the approvals:decide scope (a write PAT carries it). */
function requireDecideScope(ctx: Ctx): void {
  if (!ctx.mcpScopes?.includes("approvals:decide"))
    throw new DomainError("FORBIDDEN", { reason: "scope", scope: "approvals:decide" });
}

type Row = ApprovalRow & { snapshot: unknown; outcome?: string | null };

/** APR-EN-13, as approval.decide resolves it: approve = absorb; reject = change_order or reject. */
function resolveOutcome(a: Row, i: { decision: "approve" | "reject"; outcome?: Outcome }): Outcome | undefined {
  if (a.kind !== "out_of_scope") {
    if (i.outcome) throw new DomainError("VALIDATION", { reason: "outcome_not_allowed", kind: a.kind });
    return undefined;
  }
  const outcome = i.outcome ?? (i.decision === "approve" ? "absorb" : "reject");
  if ((outcome === "absorb") !== (i.decision === "approve"))
    throw new DomainError("VALIDATION", { reason: "outcome_mismatch", outcome, decision: i.decision });
  return outcome;
}

const OUTCOME_LABEL: Record<Outcome, string> = { absorb: "absorb", change_order: "change order", reject: "reject" };

export const approvalPrepareDecide = defineCommand({
  name: "approval.prepare_decide",
  summary:
    "Step 1 of deciding an approval from Claude: shows exactly what will change and returns a one-time " +
    "confirmation token (5 minutes). Nothing is decided until confirm_decide_approval.",
  permission: "approval.view",
  input: ApprovalDecideInput,
  exposeTo: ["mcp"],
  async run(ctx, i) {
    const user = me(ctx);
    const grantId = credential(ctx);
    const a = notFoundIfMissing(
      await ctx.tx.selectFrom("approvals").selectAll().where("id", "=", i.id).executeTakeFirst(),
    ) as unknown as Row & { assignee_id: string | null };
    const snap = a.snapshot as ApprovalSnapshot;
    // APR-EN-11: never reveal an approval the person has nothing to do with.
    if (!(a.requested_by === user.id || a.assignee_id === user.id || mayDecide(user, a.required_permission, snap.scope))) {
      throw new DomainError("NOT_FOUND");
    }
    if (a.status !== "pending") throw new DomainError("ALREADY_DECIDED", { status: a.status });
    if (a.requested_by === user.id) throw new DomainError("SELF_APPROVAL");
    const outcome = resolveOutcome(a, i);
    // MCP-OA-16 / INV-19: high-risk kinds and "absorb" are decided in the app, with a link to it.
    if (DECIDE_IN_APP_KINDS.includes(a.kind as ApprovalKind) || outcome === "absorb") {
      throw new DomainError("DECIDE_IN_APP", { kind: a.kind, ...(outcome ? { outcome } : {}), deepLink: inboxLink(a.id) });
    }
    const policy = await approvalPolicy(ctx, a.kind);
    if (!policy.channels_allowed.includes("mcp")) {
      throw new DomainError("DECIDE_IN_APP", { reason: "channel", kind: a.kind, deepLink: inboxLink(a.id) });
    }
    // Checked after INV-19 so a read-only person (e.g. finance) learns where to decide instead of a bare refusal.
    requireDecideScope(ctx);
    if (!mayDecide(user, a.required_permission, snap.scope)) throw new DomainError("FORBIDDEN", { reason: "not_an_approver" });

    const token = `${CONFIRM_TOKEN_PREFIX}${randomToken(24)}`;
    const expiresAt = new Date(ctx.now.getTime() + CONFIRM_TTL_MS);
    await ctx.tx
      .insertInto("mcp_confirm_tokens")
      .values({
        token_hash: sha256(token),
        user_id: user.id,
        grant_id: grantId,
        approval_id: a.id,
        decision: i.decision,
        outcome: outcome ?? null,
        note: i.note ?? null,
        approval_version: a.version,
        subject_version: a.subject_version,
        subject_hash: a.subject_hash,
        expires_at: expiresAt,
        created_at: ctx.now,
      })
      .execute();
    const requester = await ctx.tx.selectFrom("users").select("display_name").where("id", "=", a.requested_by).executeTakeFirst();
    const to = i.decision === "approve" ? "approved" : "rejected";
    const label = ctx.locale === "km" ? policy.label_km : policy.label_en;
    return {
      approvalId: a.id,
      kind: a.kind,
      decision: i.decision,
      ...(outcome ? { outcome } : {}),
      summary:
        `${i.decision === "approve" ? "Approve" : "Reject"} ${policy.label_en} approval ${a.id}` +
        (outcome ? ` with outcome "${OUTCOME_LABEL[outcome]}"` : "") +
        `. Ask the user to confirm, then call confirm_decide_approval with confirmToken before ${expiresAt.toISOString()}.`,
      diff: [
        { field: "status", from: "pending", to },
        ...(outcome ? [{ field: "outcome", from: null, to: outcome }] : []),
        ...(i.note ? [{ field: "decisionNote", from: null, to: i.note }] : []),
      ],
      // Plan §5.6: text people typed is returned only inside this delimited field.
      untrusted_content: {
        kindLabel: label,
        title: snap.title,
        requestedBy: requester?.display_name ?? null,
        facts: snap.facts ?? {},
        costs: can(ctx.actor, "finance.view_costs", snap.scope) ? (snap.costs ?? null) : null,
      },
      confirmToken: token,
      expiresAt,
    };
  },
  subject: (i) => ({ type: "approval", id: i.id }),
});

export const approvalConfirmDecide = defineCommand({
  name: "approval.confirm_decide",
  summary:
    "Step 2: decide the approval prepared by prepare_decide_approval (single use, 5 minutes). " +
    "This changes data — confirm with the user first.",
  permission: "approval.view",
  input: z.object({ confirmToken: z.string().min(10).max(100) }),
  exposeTo: ["mcp"],
  risk: "high",
  async run(ctx, i) {
    const user = me(ctx);
    const grantId = credential(ctx);
    requireDecideScope(ctx);
    const invalid = (reason: string) => new DomainError("CONFIRM_TOKEN_INVALID", { reason });
    const tok = await ctx.tx
      .selectFrom("mcp_confirm_tokens")
      .selectAll()
      .where("token_hash", "=", sha256(i.confirmToken))
      .forUpdate()
      .executeTakeFirst();
    // Bound to one person and one credential; single use; five minutes.
    if (!tok || tok.user_id !== user.id || tok.grant_id !== grantId) throw invalid("unknown");
    if (tok.used_at) throw invalid("used");
    if (tok.expires_at <= ctx.now) throw invalid("expired");
    const input = {
      id: tok.approval_id,
      decision: tok.decision as "approve" | "reject",
      ...(tok.outcome ? { outcome: tok.outcome as Outcome } : {}),
      ...(tok.note ? { note: tok.note } : {}),
    };
    // approval.decide in this transaction, with its own locks and checks (INV-19 included).
    const a = (await approvalDecide.load!(ctx, input)) as Row;
    if (
      a.status !== "pending" ||
      a.version !== tok.approval_version ||
      a.subject_version !== tok.subject_version ||
      a.subject_hash !== tok.subject_hash
    ) {
      throw invalid("stale");
    }
    await ctx.tx.updateTable("mcp_confirm_tokens").set({ used_at: ctx.now }).where("id", "=", tok.id).execute();
    const result = await approvalDecide.run(ctx, input, a);
    // The decision itself is audited exactly as on the other channels (plan §5.8 parity).
    await writeAudit(ctx.tx, ctx, { action: approvalDecide.name, subject: { type: "approval", id: a.id }, input });
    return result;
  },
  subject: (_i, r) => ({ type: "approval", id: r.id }),
});
