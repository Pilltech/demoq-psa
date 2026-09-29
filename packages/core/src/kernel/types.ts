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
/**
 * An influencer holding a work-log link (no account). Core resolves it from the token hash only
 * (`influencers.resolveLinkActor`); it holds just the grants listed, reaches one assignment, and is audited
 * as `link:<assignment id>`.
 */
export interface LinkActor {
  type: "influencer_link";
  name: string; // 'link:<assignment id>'
  linkId: string;
  assignmentId: string;
  grants: readonly Permission[];
}
export type Actor = UserActor | JobActor | AnonymousActor | LinkActor;

export interface RequestMeta {
  actor: Actor;
  channel: Channel;
  requestId: string;
  locale: Locale;
  /** MCP: the trusted client identity (OAuth client_id, or pat:<label>). */
  mcpClient?: string;
  /** MCP: the credential behind the call — the OAuth grant id, or pat:<api_tokens.id> (plan §5.7). */
  mcpGrantId?: string;
  /** MCP: the credential's effective scopes (read / write / approvals:decide), for commands that check them. */
  mcpScopes?: readonly string[];
  onBehalfOf?: string;
  /** When this web session last proved TOTP (step-up for high-risk decisions, APR-EN-12). */
  stepUpAt?: Date | null;
  /** Client address and user agent, where a command records them (influencer submissions). */
  ip?: string | null;
  userAgent?: string | null;
}

/** What every command and query receives. Core never calls new Date(): use ctx.now. */
export interface Ctx extends RequestMeta {
  tx: Transaction<DB>;
  now: Date;
  emit(event: string, payload: Record<string, unknown>): void;
}
