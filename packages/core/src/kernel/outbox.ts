// Outbox delivery primitives for the worker (the table is written by execute()).
import { sql } from "kysely";
import type { Kernel } from "./command";

export interface OutboxEvent {
  id: bigint;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Claim up to `batch` due events with a lease; concurrent workers never claim the same row. */
export async function claimOutbox(kernel: Kernel, batch: number, leaseMs: number): Promise<OutboxEvent[]> {
  const now = kernel.clock();
  return (
    await sql<OutboxEvent>`
      UPDATE outbox SET available_at = ${new Date(now.getTime() + leaseMs)}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox WHERE delivered_at IS NULL AND available_at <= ${now}
        ORDER BY id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      RETURNING id, event, payload, attempts`.execute(kernel.db)
  ).rows;
}

export async function completeOutbox(kernel: Kernel, id: bigint): Promise<void> {
  await kernel.db.updateTable("outbox").set({ delivered_at: kernel.clock(), last_error: null }).where("id", "=", id).execute();
}

export async function failOutbox(kernel: Kernel, id: bigint, error: string, retryInMs: number, giveUp: boolean): Promise<void> {
  const now = kernel.clock();
  await kernel.db
    .updateTable("outbox")
    .set({
      last_error: error.slice(0, 2000),
      available_at: new Date(now.getTime() + retryInMs),
      ...(giveUp && { delivered_at: now }),
    })
    .where("id", "=", id)
    .execute();
}
