// A scripted OAuth client for conformance tests (plan §8: "MCP OAuth conformance — scripted client").
// Drives the real HTTP endpoints: authorize → sign-in page → consent page → redirect with a code → token.
import { createHash, randomBytes } from "node:crypto";

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Enough of a cookie jar for one browser talking to one origin. */
export class CookieJar {
  private jar = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  /** Omit to send no PKCE; set method to test refusals. */
  codeChallenge?: string;
  codeChallengeMethod?: string;
  state?: string;
}

export interface Person {
  email: string;
  password: string;
  /** Called when the sign-in form is shown: the authenticator code to type, if any. */
  code?: () => string | undefined;
  /** Answer on the consent page. */
  consent?: "allow" | "deny";
}

export interface AuthorizeResult {
  /** Where the browser was finally sent (the client's redirect URI), if it got that far. */
  redirect?: URL;
  /** The last HTML page seen when the flow stopped on a page (e.g. an error on the sign-in form). */
  page?: { status: number; html: string };
  /** Every page the person saw, in order. */
  pages: string[];
}

export const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

export function authorizeUrl(base: string, p: AuthorizeParams): string {
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code" });
  if (p.scope !== undefined) q.set("scope", p.scope);
  if (p.resource) q.set("resource", p.resource);
  if (p.codeChallenge) q.set("code_challenge", p.codeChallenge);
  if (p.codeChallengeMethod) q.set("code_challenge_method", p.codeChallengeMethod);
  q.set("state", p.state ?? "st_" + randomBytes(6).toString("hex"));
  return `${base}/oauth/auth?${q}`;
}

/** Run the browser part of the authorization-code flow as `person`. */
export async function authorize(
  base: string,
  p: AuthorizeParams,
  person: Person,
  jar = new CookieJar(),
): Promise<AuthorizeResult> {
  const pages: string[] = [];
  let next: { url: string; init?: RequestInit } = { url: authorizeUrl(base, p) };
  for (let hop = 0; hop < 12; hop++) {
    const res = await fetch(next.url, {
      ...next.init,
      redirect: "manual",
      headers: { ...next.init?.headers, cookie: jar.header() },
    });
    jar.store(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = new URL(res.headers.get("location")!, next.url);
      if (loc.origin !== new URL(base).origin) return { redirect: loc, pages };
      next = { url: loc.toString() };
      continue;
    }
    const html = await res.text();
    pages.push(html);
    const form = /action="(\/oauth\/interaction\/[^"]+\/(login|consent))"/.exec(html);
    // An error page, or a form shown again after a POST (wrong password, missing code…): stop here.
    if (res.status !== 200 || !form || next.init?.method === "POST") return { page: { status: res.status, html }, pages };
    const csrf = csrfOf(html) ?? "";
    const uid = form[1]!.split("/")[3]!;
    const fields: Record<string, string> =
      form[2] === "login" ? { csrf, email: person.email, password: person.password, code: person.code?.() ?? "" } : { csrf };
    const action = form[2] === "consent" && person.consent === "deny" ? `/oauth/interaction/${uid}/abort` : form[1]!;
    next = {
      url: `${base}${action}`,
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(base).origin },
        body: new URLSearchParams(fields).toString(),
      },
    };
  }
  throw new Error("authorize: too many hops");
}

/** POST to the token endpoint, form-encoded (RFC 6749 §4.1.3). */
export async function tokenRequest(base: string, params: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The whole flow: authorize as `person`, exchange the code, return the token response. */
export async function oauthTokens(
  base: string,
  p: Omit<AuthorizeParams, "codeChallenge" | "codeChallengeMethod">,
  person: Person,
) {
  const { verifier, challenge } = pkcePair();
  const r = await authorize(base, { ...p, codeChallenge: challenge, codeChallengeMethod: "S256" }, person);
  const code = r.redirect?.searchParams.get("code");
  if (!code) throw new Error(`no code: ${r.redirect ?? r.page?.html.slice(0, 400)}`);
  const tok = await tokenRequest(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: verifier,
  });
  return { ...tok, flow: r };
}
