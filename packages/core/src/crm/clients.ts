// Clients and contacts. Spec: specs/crm/clients.md (CRM-CL-*)
import { sql } from "kysely";
import {
  ByIdInput,
  ClientCreateInput,
  ClientListInput,
  ClientUpdateInput,
  ContactCreateInput,
  ContactUpdateInput,
} from "@demoq/shared";
import {
  assertVersion,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
} from "../kernel";

async function lockClient(ctx: Ctx, id: string) {
  return notFoundIfMissing(
    await ctx.tx
      .selectFrom("clients")
      .select(["id", "account_lead_id", "team_id", "version", "archived_at"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst(),
  );
}

async function assertActiveUser(ctx: Ctx, userId: string) {
  const u = await ctx.tx.selectFrom("users").select("id").where("id", "=", userId).where("active", "=", true).executeTakeFirst();
  if (!u) throw new DomainError("VALIDATION", { issues: [{ path: "accountLeadId", message: "Unknown or inactive user" }] });
}

const selfId = (ctx: Ctx) => (ctx.actor.type === "user" ? ctx.actor.id : undefined);

export const clientCreate = defineCommand({
  name: "client.create",
  summary: "Create a client (you become account lead unless another is named)",
  permission: "client.manage",
  input: ClientCreateInput,
  exposeTo: ["web", "mcp"],
  // CRM-CL-02: account leads may only create clients they lead.
  scope: (_l, input, ctx) => ({ ownerIds: [input.accountLeadId ?? selfId(ctx)] }),
  async run(ctx, input) {
    const leadId = input.accountLeadId ?? selfId(ctx);
    if (!leadId) throw new DomainError("VALIDATION", { issues: [{ path: "accountLeadId", message: "Required" }] });
    await assertActiveUser(ctx, leadId);
    const row = await ctx.tx
      .insertInto("clients")
      .values({
        name: input.name,
        name_km: input.nameKm ?? null,
        account_lead_id: leadId,
        team_id: input.teamId ?? null,
        industry: input.industry ?? null,
      })
      .returning(["id", "name", "version"])
      .executeTakeFirstOrThrow();
    ctx.emit("client.created", { clientId: row.id });
    return row;
  },
  subject: (_i, r) => ({ type: "client", id: r.id }),
});

export const clientUpdate = defineCommand({
  name: "client.update",
  summary: "Edit a client's details, account lead or archive state",
  permission: "client.manage",
  input: ClientUpdateInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, input) => lockClient(ctx, input.id),
  // Moving a client to another lead needs rights over the new lead's records too.
  scope: (c, input) => ({
    ownerIds: input.accountLeadId && input.accountLeadId !== c.account_lead_id ? [] : [c.account_lead_id],
    teamIds: [c.team_id],
  }),
  async run(ctx, input, c) {
    assertVersion(c.version, input.expectedVersion);
    if (input.accountLeadId) await assertActiveUser(ctx, input.accountLeadId);
    const row = await ctx.tx
      .updateTable("clients")
      .set((eb) => ({
        version: eb("version", "+", 1),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.nameKm !== undefined && { name_km: input.nameKm }),
        ...(input.accountLeadId !== undefined && { account_lead_id: input.accountLeadId }),
        ...(input.teamId !== undefined && { team_id: input.teamId }),
        ...(input.industry !== undefined && { industry: input.industry }),
        ...(input.archived !== undefined && { archived_at: input.archived ? (c.archived_at ?? ctx.now) : null }),
      }))
      .where("id", "=", c.id)
      .returning(["id", "name", "version"])
      .executeTakeFirstOrThrow();
    return row;
  },
  subject: (i) => ({ type: "client", id: i.id }),
});

export const clientList = defineQuery({
  name: "client.list",
  summary: "Search clients by English or Khmer name",
  permission: "client.view",
  input: ClientListInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, input) {
    let q = ctx.tx
      .selectFrom("clients as c")
      .innerJoin("users as u", "u.id", "c.account_lead_id")
      .select([
        "c.id",
        "c.name",
        "c.name_km",
        "c.industry",
        "c.account_lead_id",
        "u.display_name as account_lead_name",
        "c.archived_at",
        "c.version",
      ])
      .limit(input.limit);
    if (!input.includeArchived) q = q.where("c.archived_at", "is", null);
    const term = input.search?.normalize("NFC").trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q
        .where((eb) => eb.or([eb("c.name", "ilike", like), eb("c.name_km", "ilike", like), sql<boolean>`c.name % ${term}`]))
        .orderBy(sql`similarity(c.name, ${term})`, "desc");
    }
    return q.orderBy("c.name").execute();
  },
});

export const clientGet = defineQuery({
  name: "client.get",
  summary: "One client with contacts and (if you may see the pipeline) deals",
  permission: "client.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, input) {
    const client = notFoundIfMissing(
      await ctx.tx
        .selectFrom("clients as c")
        .innerJoin("users as u", "u.id", "c.account_lead_id")
        .select([
          "c.id",
          "c.name",
          "c.name_km",
          "c.industry",
          "c.team_id",
          "c.po_required",
          "c.account_lead_id",
          "u.display_name as account_lead_name",
          "c.archived_at",
          "c.version",
        ])
        .where("c.id", "=", input.id)
        .executeTakeFirst(),
    );
    const contacts = await ctx.tx
      .selectFrom("contacts")
      .select(["id", "full_name", "title", "email", "phone", "telegram", "is_primary", "archived_at", "version"])
      .where("client_id", "=", input.id)
      .orderBy("is_primary", "desc")
      .orderBy("full_name")
      .execute();
    const deals = can(ctx.actor, "deal.view")
      ? await ctx.tx
          .selectFrom("deals")
          .select(["id", "title", "stage", "owner_id", "version"])
          .where("client_id", "=", input.id)
          .orderBy("created_at", "desc")
          .execute()
      : null;
    const canManage = can(ctx.actor, "client.manage", { ownerIds: [client.account_lead_id], teamIds: [client.team_id] });
    return { ...client, contacts, deals, canManage };
  },
  subject: (i) => ({ type: "client", id: i.id }),
});

export const contactCreate = defineCommand({
  name: "contact.create",
  summary: "Add a contact person to a client",
  permission: "client.manage",
  input: ContactCreateInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, input) => lockClient(ctx, input.clientId),
  scope: (c) => ({ ownerIds: [c.account_lead_id], teamIds: [c.team_id] }),
  async run(ctx, input, c) {
    if (input.isPrimary) {
      await ctx.tx.updateTable("contacts").set({ is_primary: false }).where("client_id", "=", c.id).where("is_primary", "=", true).execute();
    }
    return ctx.tx
      .insertInto("contacts")
      .values({
        client_id: c.id,
        full_name: input.fullName,
        title: input.title ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        telegram: input.telegram ?? null,
        is_primary: input.isPrimary,
      })
      .returning(["id", "full_name", "version"])
      .executeTakeFirstOrThrow();
  },
  subject: (_i, r) => ({ type: "contact", id: r.id }),
});

export const contactUpdate = defineCommand({
  name: "contact.update",
  summary: "Edit or archive a contact",
  permission: "client.manage",
  input: ContactUpdateInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, input) {
    return notFoundIfMissing(
      await ctx.tx
        .selectFrom("contacts as ct")
        .innerJoin("clients as c", "c.id", "ct.client_id")
        .select(["ct.id", "ct.client_id", "ct.version", "ct.archived_at", "c.account_lead_id", "c.team_id"])
        .where("ct.id", "=", input.id)
        .forUpdate()
        .executeTakeFirst(),
    );
  },
  scope: (ct) => ({ ownerIds: [ct.account_lead_id], teamIds: [ct.team_id] }),
  async run(ctx, input, ct) {
    assertVersion(ct.version, input.expectedVersion);
    if (input.isPrimary) {
      await ctx.tx
        .updateTable("contacts")
        .set({ is_primary: false })
        .where("client_id", "=", ct.client_id)
        .where("id", "<>", ct.id)
        .where("is_primary", "=", true)
        .execute();
    }
    return ctx.tx
      .updateTable("contacts")
      .set((eb) => ({
        version: eb("version", "+", 1),
        ...(input.fullName !== undefined && { full_name: input.fullName }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.telegram !== undefined && { telegram: input.telegram }),
        ...(input.isPrimary !== undefined && { is_primary: input.isPrimary }),
        ...(input.archived !== undefined && { archived_at: input.archived ? (ct.archived_at ?? ctx.now) : null }),
      }))
      .where("id", "=", ct.id)
      .returning(["id", "full_name", "version"])
      .executeTakeFirstOrThrow();
  },
  subject: (i) => ({ type: "contact", id: i.id }),
});
