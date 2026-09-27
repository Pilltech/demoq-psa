// Resolving a personal access token to an actor (MCP-02/03). Not a command: there is no actor yet.
import type { Role } from "@demoq/shared";
import { sha256, type Kernel, type UserActor } from "../kernel";
import { PAT_PREFIX } from "./commands";

export interface TokenInfo {
  tokenId: string;
  label: string;
  scopes: ("read" | "write")[];
  actor: UserActor;
  locale: "en" | "km";
}

export async function resolvePat(kernel: Kernel, bearer: string | undefined): Promise<TokenInfo | null> {
  if (!bearer?.startsWith(PAT_PREFIX)) return null;
  const now = kernel.clock();
  const row = await kernel.db
    .selectFrom("api_tokens as t")
    .innerJoin("users as u", "u.id", "t.user_id")
    .select([
      "t.id",
      "t.label",
      "t.scopes",
      "t.expires_at",
      "t.revoked_at",
      "t.last_used_at",
      "u.id as userId",
      "u.display_name",
      "u.team_id",
      "u.active",
      "u.locale",
    ])
    .where("t.token_hash", "=", sha256(bearer))
    .executeTakeFirst();
  if (!row || row.revoked_at || !row.active || row.expires_at <= now) return null;
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > 60_000) {
    await kernel.db.updateTable("api_tokens").set({ last_used_at: now }).where("id", "=", row.id).execute();
  }
  const roles = (await kernel.db.selectFrom("user_roles").select("role").where("user_id", "=", row.userId).execute()).map(
    (r) => r.role as Role,
  );
  return {
    tokenId: row.id,
    label: row.label,
    scopes: row.scopes as ("read" | "write")[],
    actor: { type: "user", id: row.userId, name: row.display_name, roles, teamId: row.team_id },
    locale: row.locale as "en" | "km",
  };
}
