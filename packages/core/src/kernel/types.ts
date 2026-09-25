import type { Transaction } from "kysely";
import type { DB } from "@demoq/db";
import type { Locale, Role } from "@demoq/shared";
import type { Permission } from "./permissions";

export type Channel = "web" | "telegram" | "mcp" | "job" | "link";
export const CHANNELS: readonly Channel[] = ["web", "telegram", "mcp", "job", "link"];

export interface UserActor {
  type: "user";
  id: string;
  name: string;
  roles: readonly Role[];
  teamId: string | null;
}
/**
 * A background job (escalation, digests, Airtable import). Jobs hold NO role; each job is given the
 * explicit permissions it needs (KER-12), with `any` scope, and is audited under its name.
 */
export interface JobActor {
  type: "job";
  name: string; // e.g. 'job:escalation'
  grants: readonly Permission[];
}
export interface AnonymousActor {
  type: "anonymous";
  name: string; // e.g. the email typed at login
}
export type Actor = UserActor | JobActor | AnonymousActor;

export interface RequestMeta {
  actor: Actor;
  channel: Channel;
  requestId: string;
  locale: Locale;
  mcpClient?: string;
  onBehalfOf?: string;
}

/** What every command and query receives. Core never calls new Date(): use ctx.now. */
export interface Ctx extends RequestMeta {
  tx: Transaction<DB>;
  now: Date;
  emit(event: string, payload: Record<string, unknown>): void;
}
