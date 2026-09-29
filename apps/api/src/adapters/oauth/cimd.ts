// Client ID Metadata Documents (Claude Code). Spec: specs/channels/mcp-oauth.md (MCP-OA-04, MCP-OA-05)
// D-MC-1: https URL, fetched with a 5 s timeout, ≤ 5 KB, JSON whose client_id equals the URL; loopback
// redirects on localhost / 127.0.0.1 match any port. Private addresses are refused (SSRF), except for the
// explicit dev/test flag that lets a local test server on 127.0.0.1 serve the document over http.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BYTES = 5 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export interface CimdOptions {
  /** Dev/test only (OAUTH_DEV_ALLOW_HTTP_CIMD): accept http://127.0.0.1|localhost document URLs. */
  allowHttpLoopback: boolean;
}

export class CimdError extends Error {}

/** Does this client_id name a metadata document we would fetch? */
export function isCimdClientId(id: string, opts: CimdOptions): boolean {
  if (id.length > 2048 || /[\s\\#]/.test(id)) return false;
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    return false;
  }
  if (u.username || u.password || u.href !== id) return false;
  if (u.pathname === "/" || /\/\.\.?(\/|$)/.test(u.pathname)) return false; // needs a path, no dot segments
  if (u.protocol === "https:") return true;
  return opts.allowHttpLoopback && u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv6");

function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** Every loopback redirect must be http on localhost/127.0.0.1; everything else https. */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000 || uri.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  return u.protocol === "https:" && !LOOPBACK_HOSTS.has(u.hostname) && u.hostname !== "[::1]";
}

/** Normalise a fetched document into the only client shape we accept: a public, code + PKCE, native client. */
export function validateCimd(id: string, doc: unknown): Record<string, unknown> & { client_id: string } {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new CimdError("not a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== id) throw new CimdError("client_id does not match the document URL");
  if ("client_secret" in d || "client_secret_expires_at" in d) throw new CimdError("public clients only");
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") {
    throw new CimdError("token_endpoint_auth_method must be none");
  }
  const redirects = d.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || !redirects.every(validRedirect)) {
    throw new CimdError("redirect_uris must be https URLs or http loopback URLs on localhost / 127.0.0.1");
  }
  const allowedGrants = new Set(["authorization_code", "refresh_token"]);
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.every((g) => allowedGrants.has(g)))) {
    throw new CimdError("unsupported grant_types");
  }
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.every((r) => r === "code"))) {
    throw new CimdError("unsupported response_types");
  }
  const name = typeof d.client_name === "string" ? d.client_name.slice(0, 120) : undefined;
  const uri = typeof d.client_uri === "string" && d.client_uri.startsWith("https://") ? d.client_uri : undefined;
  return {
    client_id: id,
    ...(name ? { client_name: name } : {}),
    ...(uri ? { client_uri: uri } : {}),
    redirect_uris: redirects as string[],
    // native: loopback redirects match on any port (RFC 8252 §7.3).
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > CIMD_MAX_BYTES) throw new CimdError("document too large");
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CIMD_MAX_BYTES) {
      await reader.cancel();
      throw new CimdError("document too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetch and validate a Client ID Metadata Document. Throws CimdError with a reason (logged, never shown raw). */
export async function fetchCimd(id: string, opts: CimdOptions): Promise<Record<string, unknown> & { client_id: string }> {
  if (!isCimdClientId(id, opts)) throw new CimdError("not a metadata document URL");
  const url = new URL(id);
  const localDev = opts.allowHttpLoopback && LOOPBACK_HOSTS.has(url.hostname);
  if (!localDev) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new CimdError("metadata host resolves to a private address");
    }
  }
  let res: Response;
  try {
    res = await fetch(id, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CimdError(`fetch failed: ${(err as Error).name}`);
  }
  if (res.status !== 200) throw new CimdError(`unexpected status ${res.status}`);
  const text = await readCapped(res);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CimdError("invalid JSON");
  }
  return validateCimd(id, doc);
}
