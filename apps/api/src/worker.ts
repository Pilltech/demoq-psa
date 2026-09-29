// Worker process: drains the outbox continuously, runs the escalation job every minute and the S3 schedule.
// Same image as the API, different entrypoint (`pnpm start:worker`).
import { createDb } from "@demoq/db";
import { httpBotApi } from "./adapters/telegram";
import { loadConfig } from "./config";
import { drainOutbox, escalate } from "./worker/outbox";
import { newScheduleState, runSchedule } from "./worker/schedule";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL, 4);
const kernel = { db, clock: () => new Date() };
const bot = config.TELEGRAM_BOT_TOKEN ? httpBotApi(config.TELEGRAM_BOT_TOKEN) : null;
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: "info", msg, ...extra }));

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

let lastEscalation = 0;
const schedule = newScheduleState();
log("worker_started", { telegram: !!bot });
while (!stopping) {
  try {
    const n = await drainOutbox(kernel, { bot, log });
    if (Date.now() - lastEscalation > 60_000) {
      lastEscalation = Date.now();
      const r = await escalate(kernel);
      if (r.moved) log("escalated", r);
      await runSchedule(kernel, schedule, {
        reviewRequesterId: config.BYPASS_REVIEW_REQUESTER_ID,
        log,
        onTimeJobs: (r) => log("time_jobs", r),
      });
    }
    if (!n) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "worker_loop_error", err: String(err) }));
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await db.destroy();
