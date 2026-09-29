// Factories build synthetic data only. Real client data never enters tests or Claude sessions.
import { randomBytes } from "node:crypto";
import type { Database } from "@demoq/db";
import { identity, type Channel, type RequestMeta, type UserActor } from "@demoq/core";
import type { Role } from "@demoq/shared";

export const TEST_PASSWORD = "correct-horse-battery-staple";
let passwordHash: Promise<string> | undefined;
const uniq = () => randomBytes(3).toString("hex");

export async function makeTeam(db: Database, name = `Team ${uniq()}`) {
  return db.insertInto("teams").values({ name }).returning(["id", "name"]).executeTakeFirstOrThrow();
}

export async function makeUser(
  db: Database,
  opts: { roles: Role[]; teamId?: string | null; name?: string; email?: string; locale?: "en" | "km" },
): Promise<UserActor & { email: string }> {
  passwordHash ??= identity.hashPassword(TEST_PASSWORD);
  const name = opts.name ?? `${opts.roles[0] ?? "user"} ${uniq()}`;
  const u = await db
    .insertInto("users")
    .values({
      email: opts.email ?? `${name.toLowerCase().replace(/\W+/g, ".")}@demoq.test`,
      display_name: name,
      team_id: opts.teamId ?? null,
      locale: opts.locale ?? "en",
      password_hash: await passwordHash,
    })
    .returning(["id", "email", "display_name", "team_id"])
    .executeTakeFirstOrThrow();
  if (opts.roles.length) {
    await db
      .insertInto("user_roles")
      .values(opts.roles.map((role) => ({ user_id: u.id, role })))
      .execute();
  }
  return { type: "user", id: u.id, name: u.display_name, roles: opts.roles, teamId: u.team_id, email: u.email };
}

export function meta(actor: RequestMeta["actor"], channel: Channel = "web", extra: Partial<RequestMeta> = {}): RequestMeta {
  return { actor, channel, requestId: `req_${uniq()}`, locale: "en", ...extra };
}

export async function makeClient(db: Database, accountLeadId: string, name = `Client ${uniq()}`, teamId: string | null = null) {
  return db
    .insertInto("clients")
    .values({ name, account_lead_id: accountLeadId, team_id: teamId })
    .returning(["id", "name", "version"])
    .executeTakeFirstOrThrow();
}

export async function makeDeal(db: Database, clientId: string, ownerId: string, title = `Deal ${uniq()}`) {
  return db
    .insertInto("deals")
    .values({ client_id: clientId, owner_id: ownerId, title })
    .returning(["id", "stage", "version"])
    .executeTakeFirstOrThrow();
}

export async function engagementTypeId(db: Database, code = "campaign") {
  return (await db.selectFrom("engagement_types").select("id").where("code", "=", code).executeTakeFirstOrThrow()).id;
}

/** A quote line in the API's input shape. Money in minor units as strings; qty in whole units. */
export function line(
  kind: "fee" | "pass_through",
  qty: number,
  unitPrice: number,
  unitCost: number,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    descriptionEn: `${kind} line`,
    qtyMilli: qty * 1000,
    unitPriceMinor: String(unitPrice),
    unitCostMinor: String(unitCost),
    ...extra,
  };
}

/** D-MC-3: switch the mcp.writes flag (off by default). Tests that call write tools over MCP turn it on. */
export async function setMcpWrites(db: Database, on: boolean) {
  await db
    .insertInto("settings")
    .values({ key: "mcp.writes", value: JSON.stringify(on) })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(on) }))
    .execute();
}
