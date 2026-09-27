// Outbox worker: claims events with a lease (FOR UPDATE SKIP LOCKED), dispatches, marks delivered.
// Replaces pg-boss for S2 (ADR-0003 revised): one table, transactional enqueue, safe with N workers.
import { randomUUID } from "node:crypto";
import {
  approvals,
  claimOutbox,
  commercial,
  completeOutbox,
  DomainError,
  execute,
  failOutbox,
  identity,
  type JobActor,
  type Kernel,
  type OutboxEvent,
} from "@demoq/core";
import { sendApprovalCard, type BotApi } from "../adapters/telegram";

export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 8;

export interface WorkerDeps {
  bot: BotApi | null;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

type Event = OutboxEvent;
type Handler = (kernel: Kernel, deps: WorkerDeps, e: Event) => Promise<void>;

const ESCALATION_JOB: JobActor = { type: "job", name: "job:escalation", grants: ["approval.escalate"] };

const handlers: Record<string, Handler> = {
  // TG-08: tell the (new) assignee on Telegram.
  "approval.assigned": async (kernel, deps, e) => {
    const { assigneeId, approvalId } = e.payload as { assigneeId?: string; approvalId: string };
    if (deps.bot && assigneeId) await sendApprovalCard(kernel, deps.bot, assigneeId, approvalId, `outbox_${e.id}`);
  },
  "approval.escalated": async (kernel, deps, e) => handlers["approval.assigned"]!(kernel, deps, e),
  // COM-QB-08: send as the requester, on behalf of the approval (re-authorised by execute()).
  "quote.send_requested": async (kernel, deps, e) => {
    const { quoteId, requesterId, approvalId, subjectHash } = e.payload as {
      quoteId: string;
      requesterId: string;
      approvalId: string;
      subjectHash?: string;
    };
    const who = await identity.loadActor(kernel, requesterId);
    if (!who) return;
    const q = await commercial.quoteState(kernel, quoteId);
    const a = await approvals.approvalState(kernel, approvalId);
    // Only the exact content that was approved, still flagged for auto-send; anything else was edited meanwhile.
    if (
      q?.status !== "ready" ||
      !q.send_on_approval ||
      a?.status !== "approved" ||
      !subjectHash ||
      a.subject_hash !== subjectHash ||
      q.content_sha256 !== subjectHash
    ) {
      deps.log?.("send_on_approval_skipped", { quoteId, approvalId });
      return;
    }
    try {
      await execute(
        kernel,
        { actor: who.actor, channel: "job", requestId: `outbox_${e.id}`, locale: who.locale, onBehalfOf: approvalId },
        commercial.quoteSend,
        {
          id: quoteId,
          expectedVersion: q.version,
        },
      );
    } catch (err) {
      // A rule said no (e.g. FX rate missing): record it, do not retry; the quote stays ready for a manual send.
      if (err instanceof DomainError) {
        deps.log?.("send_on_approval_refused", { quoteId, code: err.code });
        return;
      }
      throw err;
    }
  },
};

/** Claim a batch with a lease, dispatch each, and record the outcome. Returns how many were processed. */
export async function drainOutbox(kernel: Kernel, deps: WorkerDeps, batch = 20): Promise<number> {
  // Claim one event at a time: a slow handler never holds a lease on work another worker could do.
  const claimed: Event[] = [];
  for (let n = 0; n < batch; n++) {
    const [e] = await claimOutbox(kernel, 1, LEASE_MS);
    if (!e) break;
    claimed.push(e);
    await handle(kernel, deps, e);
  }
  return claimed.length;
}

async function handle(kernel: Kernel, deps: WorkerDeps, e: Event) {
  try {
    await handlers[e.event]?.(kernel, deps, e);
    await completeOutbox(kernel, e.id);
  } catch (err) {
    const giveUp = e.attempts >= MAX_ATTEMPTS;
    await failOutbox(kernel, e.id, String(err), Math.min(2 ** e.attempts * 1000, 30 * 60_000), giveUp);
    deps.log?.(giveUp ? "outbox_dead_letter" : "outbox_retry", { id: String(e.id), event: e.event, err: String(err) });
  }
}

/** APR-EN-08 tick. */
export async function escalate(kernel: Kernel) {
  return execute(
    kernel,
    { actor: ESCALATION_JOB, channel: "job", requestId: `esc_${randomUUID()}`, locale: "en" },
    approvals.approvalEscalateOverdue,
    {},
  );
}
