// Users and teams (admin). Spec: specs/identity/users.md
import { z } from "zod";
import { TeamCreateInput, UserCreateInput, UserSetLocaleInput, UserSetRolesInput, type Role } from "@demoq/shared";
import { assertVersion, defineCommand, defineQuery, DomainError, notFoundIfMissing } from "../kernel";
import { hashPassword } from "./auth";

export const userCreate = defineCommand({
  name: "user.create",
  summary: "Create a staff account with roles and an initial password",
  permission: "user.manage",
  input: UserCreateInput,
  exposeTo: ["web"],
  async run(ctx, input) {
    const password_hash = await hashPassword(input.initialPassword);
    const user = await ctx.tx
      .insertInto("users")
      .values({
        email: input.email,
        display_name: input.displayName,
        display_name_km: input.displayNameKm ?? null,
        locale: input.locale,
        team_id: input.teamId ?? null,
        manager_id: input.managerId ?? null,
        password_hash,
      })
      .returning(["id", "email", "display_name", "version"])
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("user_roles")
      .values([...new Set(input.roles)].map((role) => ({ user_id: user.id, role })))
      .execute();
    ctx.emit("user.created", { userId: user.id });
    return { id: user.id, email: user.email, displayName: user.display_name, version: user.version };
  },
  subject: (_i, r) => ({ type: "user", id: r.id }),
});

export const userSetRoles = defineCommand({
  name: "user.set_roles",
  summary: "Replace a user's roles",
  permission: "user.manage",
  input: UserSetRolesInput,
  exposeTo: ["web"],
  risk: "high",
  async load(ctx, input) {
    return notFoundIfMissing(
      await ctx.tx.selectFrom("users").select(["id", "version"]).where("id", "=", input.userId).forUpdate().executeTakeFirst(),
    );
  },
  async run(ctx, input, user) {
    assertVersion(user.version, input.expectedVersion);
    // Admins cannot grant themselves business roles (segregation of duties: admin makes no business approvals).
    if (ctx.actor.type === "user" && ctx.actor.id === user.id) {
      throw new DomainError("FORBIDDEN", { reason: "self_role_change" });
    }
    await ctx.tx.deleteFrom("user_roles").where("user_id", "=", user.id).execute();
    const roles = [...new Set(input.roles)];
    if (roles.length) {
      await ctx.tx
        .insertInto("user_roles")
        .values(roles.map((role) => ({ user_id: user.id, role })))
        .execute();
    }
    // Revoke sessions so the new permissions apply immediately.
    await ctx.tx
      .updateTable("sessions")
      .set({ revoked_at: ctx.now })
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .execute();
    // …and their access tokens, so MCP picks up the new roles with a fresh, correctly-scoped token.
    await ctx.tx
      .updateTable("api_tokens")
      .set({ revoked_at: ctx.now })
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .execute();
    const updated = await ctx.tx
      .updateTable("users")
      .set((eb) => ({ version: eb("version", "+", 1) }))
      .where("id", "=", user.id)
      .returning("version")
      .executeTakeFirstOrThrow();
    return { id: user.id, roles: roles as Role[], version: updated.version };
  },
  subject: (i) => ({ type: "user", id: i.userId }),
});

export const userSetLocale = defineCommand({
  name: "user.set_locale",
  summary: "Set my display language (en or km)",
  permission: "user.directory",
  input: UserSetLocaleInput,
  exposeTo: ["web", "telegram", "mcp"],
  async run(ctx, input) {
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    await ctx.tx.updateTable("users").set({ locale: input.locale }).where("id", "=", ctx.actor.id).execute();
    return { locale: input.locale };
  },
  subject: (_i, _r) => undefined,
});

export const teamCreate = defineCommand({
  name: "team.create",
  summary: "Create a team",
  permission: "team.manage",
  input: TeamCreateInput,
  exposeTo: ["web"],
  async run(ctx, input) {
    return ctx.tx
      .insertInto("teams")
      .values({ name: input.name, name_km: input.nameKm ?? null })
      .returning(["id", "name", "name_km"])
      .executeTakeFirstOrThrow();
  },
  subject: (_i, r) => ({ type: "team", id: r.id }),
});

export const userDirectory = defineQuery({
  name: "user.directory",
  summary: "List active staff (name, team, roles) for pickers",
  permission: "user.directory",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx) {
    const users = await ctx.tx
      .selectFrom("users")
      .select(["id", "display_name", "display_name_km", "team_id", "email", "version"])
      .where("active", "=", true)
      .orderBy("display_name")
      .execute();
    const roles = await ctx.tx.selectFrom("user_roles").select(["user_id", "role"]).execute();
    return users.map((u) => ({
      id: u.id,
      displayName: u.display_name,
      displayNameKm: u.display_name_km,
      teamId: u.team_id,
      email: u.email,
      version: u.version,
      roles: roles.filter((r) => r.user_id === u.id).map((r) => r.role as Role),
    }));
  },
});

export const teamList = defineQuery({
  name: "team.list",
  summary: "List teams",
  permission: "user.directory",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx) {
    return ctx.tx.selectFrom("teams").select(["id", "name", "name_km"]).orderBy("name").execute();
  },
});
