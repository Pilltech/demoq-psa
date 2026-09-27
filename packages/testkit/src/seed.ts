// Synthetic demo data for local dev and staging. NEVER real client data (principle 10).
// Usage: pnpm seed   (idempotent: skips if the admin already exists)
import { sql } from "kysely";
import { createDb } from "@demoq/db";
import { commercial, execute, identity, type Kernel, type OpDef, type UserActor } from "@demoq/core";
import type { Role } from "@demoq/shared";

export const SEED_PASSWORD = "demoq-demo-2026";

const people: { email: string; name: string; nameKm?: string; roles: Role[]; team?: string }[] = [
  { email: "admin@demoq.test", name: "Sys Admin", roles: ["admin"] },
  { email: "ceo@demoq.test", name: "Chenda CEO", nameKm: "ចិន្តា", roles: ["ceo"] },
  { email: "ops@demoq.test", name: "Vanna Ops", nameKm: "វណ្ណា", roles: ["ops_lead"] },
  { email: "finance@demoq.test", name: "Sreymom Finance", roles: ["finance"] },
  { email: "sokha@demoq.test", name: "Sokha Lead", nameKm: "សុខា", roles: ["account_lead"], team: "Accounts" },
  { email: "dara@demoq.test", name: "Dara Lead", nameKm: "តារា", roles: ["account_lead"], team: "Accounts" },
  { email: "pisey@demoq.test", name: "Pisey PM", roles: ["project_manager"], team: "Delivery" },
  { email: "bopha@demoq.test", name: "Bopha Designer", roles: ["staff"], team: "Creative" },
  { email: "viewer@demoq.test", name: "Rith Viewer", roles: ["viewer"] },
  // S3: a second ops lead and a second admin, so the S3 demo (and its E2E) has its own TOTP enrolments.
  { email: "kosal@demoq.test", name: "Kosal Ops", nameKm: "កុសល", roles: ["ops_lead"] },
  // Also a viewer: task_template.list needs project.view, which the admin role alone does not hold (reported as an
  // S3 backend gap), so a plain admin cannot load the template editor yet.
  { email: "config@demoq.test", name: "Nimol Config", roles: ["admin"] },
];

/** "Standard 2026 USD" rate card. Synthetic prices and costs in US cents. */
const RATE_CARD_ITEMS: {
  code: string;
  kind: "fee" | "pass_through";
  en: string;
  km: string;
  unit: "hour" | "day" | "item" | "post" | "month" | "lump";
  price: bigint;
  cost: bigint;
}[] = [
  { code: "VID-EDIT-HR", kind: "fee", en: "Video editing", km: "កាត់តវីដេអូ", unit: "hour", price: 5_000n, cost: 2_500n },
  { code: "SOC-POST", kind: "fee", en: "Social media post", km: "ប្រកាសបណ្ដាញសង្គម", unit: "post", price: 15_000n, cost: 6_000n },
  {
    code: "KOL-POST",
    kind: "pass_through",
    en: "Influencer post",
    km: "ប្រកាសអ្នកមានឥទ្ធិពល",
    unit: "post",
    price: 40_000n,
    cost: 35_000n,
  },
  { code: "EVENT-DAY", kind: "fee", en: "Event day", km: "ថ្ងៃព្រឹត្តិការណ៍", unit: "day", price: 80_000n, cost: 50_000n },
  { code: "STRAT-HR", kind: "fee", en: "Strategy", km: "យុទ្ធសាស្ត្រ", unit: "hour", price: 8_000n, cost: 3_500n },
  {
    code: "ADS-MGMT",
    kind: "fee",
    en: "Ads management",
    km: "គ្រប់គ្រងការផ្សាយពាណិជ្ជកម្ម",
    unit: "month",
    price: 60_000n,
    cost: 24_000n,
  },
];
/** Demo USD→KHR rate: 4,100 riel per USD, stored × 10⁶. */
const SEED_KHR_PER_USD_MICROS = 4_100_000_000n;
/** Today's calendar date in Phnom Penh, where business dates live. */
const phnomPenhToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());

/** S3 demo: a quote on Kampot Pepper Co.'s deal, sent to the client and waiting to be accepted. */
export const S3_CLIENT = "Kampot Pepper Co.";
export const S3_DEAL = "Harvest festival campaign";
export const S3_QUOTE = "Harvest festival launch";

/** Built through the real commands (as Sokha, on the web channel), so totals, hashes and audit are the server's own. */
async function seedSentQuote(db: ReturnType<typeof createDb>["db"], sokhaId: string) {
  const team = await db.selectFrom("users").select("team_id").where("id", "=", sokhaId).executeTakeFirstOrThrow();
  const actor: UserActor = { type: "user", id: sokhaId, name: "Sokha Lead", roles: ["account_lead"], teamId: team.team_id };
  const kernel: Kernel = { db, clock: () => new Date() };
  const run = <T>(op: OpDef, input: unknown) =>
    execute(kernel, { actor, channel: "web", requestId: "seed", locale: "en" }, op, input) as Promise<T>;
  const deal = await db.selectFrom("deals").select("id").where("title", "=", S3_DEAL).executeTakeFirstOrThrow();
  const et = await db.selectFrom("engagement_types").select("id").where("code", "=", "campaign").executeTakeFirstOrThrow();
  const pt = await db.selectFrom("project_types").select("id").where("code", "=", "campaign").executeTakeFirstOrThrow();
  const card = await db.selectFrom("rate_cards").select("id").where("name", "=", "Standard 2026 USD").executeTakeFirstOrThrow();
  const items = await db
    .selectFrom("rate_card_items")
    .select(["id", "service_code"])
    .where("rate_card_id", "=", card.id)
    .execute();
  const item = (code: string) => items.find((i) => i.service_code === code)!.id;
  const q = await run<{ id: string; version: number }>(commercial.quoteCreate, {
    dealId: deal.id,
    title: S3_QUOTE,
    currency: "USD",
    engagementTypeId: et.id,
    projectTypeId: pt.id,
    rateCardId: card.id,
    billingModel: "one_off",
  });
  const saved = await run<{ version: number }>(commercial.quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: [
      {
        kind: "fee",
        rateCardItemId: item("SOC-POST"),
        descriptionEn: "Social media post",
        descriptionKm: "ប្រកាសបណ្ដាញសង្គម",
        qtyMilli: 6000,
        unitPriceMinor: "15000",
        quotedMinutes: 720,
      },
      {
        kind: "fee",
        rateCardItemId: item("STRAT-HR"),
        descriptionEn: "Strategy",
        descriptionKm: "យុទ្ធសាស្ត្រ",
        qtyMilli: 5000,
        unitPriceMinor: "8000",
        quotedMinutes: 300,
      },
    ],
  });
  const sub = await run<{ version: number; status: string }>(commercial.quoteSubmit, {
    id: q.id,
    expectedVersion: saved.version,
  });
  if (sub.status !== "ready") throw new Error(`seed: expected the S3 quote to be ready, got ${sub.status}`);
  await run(commercial.quoteSend, { id: q.id, expectedVersion: sub.version });
}

export async function seed(url: string) {
  const { db } = createDb(url, 2);
  try {
    const exists = await db.selectFrom("users").select("id").where("email", "=", "admin@demoq.test").executeTakeFirst();
    if (exists) return { skipped: true as const };
    const hash = await identity.hashPassword(SEED_PASSWORD);
    const ids = new Map<string, string>();
    await db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.actor_name', 'seed', true), set_config('app.channel', 'job', true), set_config('app.request_id', 'seed', true)`.execute(
        tx,
      );
      const teams = new Map<string, string>();
      for (const name of ["Accounts", "Delivery", "Creative"]) {
        const t = await tx.insertInto("teams").values({ name }).returning("id").executeTakeFirstOrThrow();
        teams.set(name, t.id);
      }
      for (const p of people) {
        const u = await tx
          .insertInto("users")
          .values({
            email: p.email,
            display_name: p.name,
            display_name_km: p.nameKm ?? null,
            password_hash: hash,
            team_id: p.team ? teams.get(p.team)! : null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        ids.set(p.email, u.id);
        await tx
          .insertInto("user_roles")
          .values(p.roles.map((role) => ({ user_id: u.id, role })))
          .execute();
      }
      const sokha = ids.get("sokha@demoq.test")!;
      const dara = ids.get("dara@demoq.test")!;
      const clients: [string, string | null, string, string][] = [
        ["Angkor Beverages", "ភេសជ្ជៈអង្គរ", "FMCG", sokha],
        ["Mekong Telecom", "មេគង្គ តេឡេខម", "Telecom", sokha],
        ["Sabay Coffee", "កាហ្វេសប្បាយ", "F&B", dara],
        ["Phnom Penh Motors", null, "Automotive", dara],
      ];
      const clientIds: string[] = [];
      for (const [name, name_km, industry, lead] of clients) {
        const c = await tx
          .insertInto("clients")
          .values({ name, name_km, industry, account_lead_id: lead, team_id: teams.get("Accounts")! })
          .returning("id")
          .executeTakeFirstOrThrow();
        clientIds.push(c.id);
        await tx
          .insertInto("contacts")
          .values({
            client_id: c.id,
            full_name: `Marketing Head, ${name}`,
            is_primary: true,
            email: `marketing@${name.toLowerCase().replace(/\W+/g, "")}.example`,
          })
          .execute();
      }
      clientIds.push(
        (
          await tx
            .insertInto("clients")
            .values({
              name: S3_CLIENT,
              name_km: "ម្រេចកំពត",
              industry: "Agriculture",
              account_lead_id: sokha,
              team_id: teams.get("Accounts")!,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id,
      );
      const deals: [number, string, string, "lead" | "qualified" | "proposal" | "negotiation", bigint][] = [
        [0, "Khmer New Year TikTok campaign", sokha, "proposal", 1_200_000n],
        [0, "Q1 always-on social", sokha, "qualified", 450_000n],
        [1, "5G launch influencer push", sokha, "negotiation", 2_500_000n],
        [2, "Store opening event", dara, "lead", 300_000n],
        [3, "New model video series", dara, "proposal", 1_800_000n],
        [4, S3_DEAL, sokha, "negotiation", 900_000n],
      ];
      for (const [ci, title, owner, stage, value] of deals) {
        const d = await tx
          .insertInto("deals")
          .values({ client_id: clientIds[ci]!, title, owner_id: owner, stage, expected_value_minor: value, currency: "USD" })
          .returning("id")
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("deal_stage_history")
          .values({ deal_id: d.id, from_stage: null, to_stage: stage, changed_by: owner })
          .execute();
      }
      const card = await tx
        .insertInto("rate_cards")
        .values({ name: "Standard 2026 USD", currency: "USD" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("rate_card_items")
        .values(
          RATE_CARD_ITEMS.map((it) => ({
            rate_card_id: card.id,
            service_code: it.code,
            kind: it.kind,
            label_en: it.en,
            label_km: it.km,
            unit: it.unit,
            unit_price_minor: it.price,
            unit_cost_minor: it.cost,
          })),
        )
        .execute();
      await tx
        .insertInto("fx_rates")
        .values({ rate_date: phnomPenhToday(), rate_micros: SEED_KHR_PER_USD_MICROS, entered_by: ids.get("finance@demoq.test")! })
        .execute();
    });
    await seedSentQuote(db, ids.get("sokha@demoq.test")!);
    return { skipped: false as const, people: people.map((p) => `${p.email} (${p.roles.join(", ")})`) };
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const r = await seed(url);
  if (r.skipped) console.log("seed: already seeded, nothing to do");
  else
    console.log(
      `seed: done. Password for everyone: ${SEED_PASSWORD}\n  ${r.people.join("\n  ")}\nRoles ceo/director/ops_lead/finance/admin will be asked to set up TOTP.`,
    );
}
