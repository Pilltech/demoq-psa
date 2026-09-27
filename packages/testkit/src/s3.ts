// Sprint 3 scenario builders: a sent quote, an accepted project. Synthetic data only.
import { commercial, execute, type JobActor, type OpDef, type UserActor } from "@demoq/core";
import type { TestDb } from "./db";
import { engagementTypeId, line, makeClient, makeDeal, meta } from "./factories";

export const runAs = <T>(
  t: TestDb,
  a: UserActor | JobActor,
  op: OpDef,
  input: unknown,
  channel: "web" | "mcp" | "telegram" | "job" = a.type === "job" ? "job" : "web",
) => execute(t.kernel, meta(a, channel), op, input) as Promise<T>;

export async function projectTypeId(t: TestDb, code = "campaign") {
  return (await t.db.selectFrom("project_types").select("id").where("code", "=", code).executeTakeFirstOrThrow()).id;
}

export interface SentQuote {
  id: string;
  version: number;
  dealId: string;
  clientId: string;
  clientName: string;
}

/** A client, a deal owned by `lead`, and a quote sent at or above the floor. */
export async function sentQuote(
  t: TestDb,
  lead: UserActor,
  opts: {
    lines?: unknown[];
    billingModel?: "one_off" | "retainer";
    periodMonths?: number;
    projectType?: string;
    rateCardId?: string;
  } = {},
): Promise<SentQuote> {
  const client = await makeClient(t.db, lead.id);
  const deal = await makeDeal(t.db, client.id, lead.id);
  const q = await runAs<{ id: string; version: number }>(t, lead, commercial.quoteCreate, {
    dealId: deal.id,
    title: "Launch campaign",
    currency: "USD",
    engagementTypeId: await engagementTypeId(t.db, "campaign"),
    projectTypeId: await projectTypeId(t, opts.projectType ?? "campaign"),
    rateCardId: opts.rateCardId ?? null,
    billingModel: opts.billingModel ?? "one_off",
    periodMonths: opts.periodMonths ?? null,
  });
  const saved = await runAs<{ version: number }>(t, lead, commercial.quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: opts.lines ?? [line("fee", 10, 5000, 3000, { quotedMinutes: 600 }), line("pass_through", 1, 110_000, 100_000)],
  });
  const sub = await runAs<{ version: number; status: string }>(t, lead, commercial.quoteSubmit, {
    id: q.id,
    expectedVersion: saved.version,
  });
  if (sub.status !== "ready") throw new Error(`sentQuote: expected ready, got ${sub.status}`);
  const sent = await runAs<{ version: number }>(t, lead, commercial.quoteSend, { id: q.id, expectedVersion: sub.version });
  return { id: q.id, version: sent.version, dealId: deal.id, clientId: client.id, clientName: client.name };
}

export interface AcceptedProject extends SentQuote {
  projectId: string;
  scopeId: string;
  tasksCreated: number;
}

export async function acceptedProject(
  t: TestDb,
  lead: UserActor,
  opts: Parameters<typeof sentQuote>[2] & { plannedStart?: string; pmId?: string } = {},
): Promise<AcceptedProject> {
  const q = await sentQuote(t, lead, opts);
  const r = await runAs<{ projectId: string; scopeId: string; tasksCreated: number }>(t, lead, commercial.quoteAccept, {
    id: q.id,
    expectedVersion: q.version,
    winReasonCode: "creative",
    plannedStart: opts.plannedStart ?? "2026-11-02",
    projectManagerId: opts.pmId ?? null,
  });
  return { ...q, ...r };
}
