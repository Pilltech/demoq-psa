import type { Role } from "@demoq/shared";
import { PERMISSIONS, type Permission, type Scope } from "./permissions";
import type { Actor } from "./types";
import { DomainError } from "./errors";

/** How a record relates to people, for evaluating own/team/assigned grants. */
export interface ResourceScope {
  ownerIds?: readonly (string | null | undefined)[];
  teamIds?: readonly (string | null | undefined)[];
  assigneeIds?: readonly (string | null | undefined)[];
}

/** Every scope the actor holds for a permission, across all their roles. */
export function scopesFor(actor: Actor, permission: Permission): Set<Scope> {
  const out = new Set<Scope>();
  if (actor.type !== "user") return out;
  const grants = PERMISSIONS[permission].grants as Partial<Record<Role, Scope>>;
  for (const role of actor.roles) {
    const s = grants[role];
    if (s) out.add(s);
  }
  return out;
}

export function can(actor: Actor, permission: Permission, resource?: ResourceScope): boolean {
  if (actor.type !== "user") return false;
  const scopes = scopesFor(actor, permission);
  if (scopes.has("any")) return true;
  if (!resource) return false;
  if (scopes.has("own") && resource.ownerIds?.includes(actor.id)) return true;
  if (scopes.has("team") && actor.teamId && resource.teamIds?.includes(actor.teamId)) return true;
  if (scopes.has("assigned") && resource.assigneeIds?.includes(actor.id)) return true;
  return false;
}

export function assertCan(actor: Actor, permission: Permission, resource?: ResourceScope): void {
  if (!can(actor, permission, resource)) throw new DomainError("FORBIDDEN", { permission });
}

/** For list queries: the row filter this actor gets, or null when they hold no grant at all. */
export type RowFilter = { kind: "any" } | { kind: "scoped"; userId: string; teamId: string | null; scopes: Set<Scope> };
export function rowFilter(actor: Actor, permission: Permission): RowFilter | null {
  if (actor.type !== "user") return null;
  const scopes = scopesFor(actor, permission);
  if (scopes.size === 0) return null;
  if (scopes.has("any")) return { kind: "any" };
  return { kind: "scoped", userId: actor.id, teamId: actor.teamId, scopes };
}
