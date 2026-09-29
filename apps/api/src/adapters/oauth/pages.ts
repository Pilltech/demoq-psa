// Server-rendered sign-in and consent pages for OAuth (MCP-OA-10, MCP-OA-11). EN + KM, no external
// assets, no script; the only style is hashed into the CSP. Khmer text marked KM-DRAFT: until reviewed.
import { createHash } from "node:crypto";
import type { Locale } from "@demoq/shared";

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
main{max-width:28rem;margin:2rem auto;background:#fff;border-radius:12px;padding:1.5rem;box-shadow:0 1px 4px #0002}
h1{font-size:1.3rem;margin:0 0 1rem}label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input[type=email],input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #c5cad3;border-radius:8px;font:inherit}
button{margin-top:1rem;padding:.6rem 1.2rem;border-radius:8px;border:0;font:inherit;cursor:pointer}
.primary{background:#1f5eff;color:#fff}.secondary{background:#e7e9ee;color:#1d2330}
.err{background:#fde8e8;color:#8a1111;padding:.6rem;border-radius:8px}.muted{color:#5b6374;font-size:.9rem}
ul{padding-left:1.2rem}code{word-break:break-all}.row{display:flex;gap:.5rem;flex-wrap:wrap}
.lang{float:right;font-size:.9rem}`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** CSP for these pages: nothing loads, forms post here and (through the redirect chain) to the client. */
export function pageCsp(formTargets: string[]): string {
  return [
    "default-src 'none'",
    `style-src 'sha256-${STYLE_HASH}'`,
    `form-action 'self' ${formTargets.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

type Key =
  | "signInTitle"
  | "signInIntro"
  | "email"
  | "password"
  | "code"
  | "codeHelp"
  | "signIn"
  | "cancel"
  | "consentTitle"
  | "consentIntro"
  | "redirect"
  | "asks"
  | "refused"
  | "remember"
  | "allow"
  | "deny"
  | "scope.read"
  | "scope.write"
  | "scope.approvals:decide"
  | "notEnrolled"
  | "expired"
  | "otherLang";

const T: Record<Locale, Record<Key, string>> = {
  en: {
    signInTitle: "Sign in to DemoQ",
    signInIntro: "{client} wants to use DemoQ for you. Sign in to continue.",
    email: "Email",
    password: "Password",
    code: "Authenticator code",
    codeHelp: "Needed for CEO, directors, ops leads, finance and admins, and for anyone who turned on two-step sign-in.",
    signIn: "Sign in",
    cancel: "Cancel",
    consentTitle: "Allow access to DemoQ?",
    consentIntro: "{client} will act as {name} in DemoQ, with the same permissions you have on screen.",
    redirect: "After you answer you will be sent to:",
    asks: "It asks to:",
    refused: "Not available for your role (you will get read access only):",
    remember: "DemoQ remembers this answer for this app for 30 days. Every action is recorded under your name.",
    allow: "Allow",
    deny: "Deny",
    "scope.read": "Read what you can see in DemoQ",
    "scope.write": "Change what you can change in DemoQ (only while changes from Claude are switched on)",
    "scope.approvals:decide":
      "Decide approvals, one confirmed decision at a time (never margin floor, gate bypass, bypass review, influencer work or absorbing out-of-scope work)",
    notEnrolled: "Set up two-step sign-in in the DemoQ app first, then try again.",
    expired: "This sign-in request has expired or is not valid. Start again from Claude.",
    otherLang: "ខ្មែរ",
  },
  km: {
    signInTitle: "KM-DRAFT: ចូលប្រើ DemoQ",
    signInIntro: "KM-DRAFT: {client} ចង់ប្រើ DemoQ ជំនួសអ្នក។ សូមចូលដើម្បីបន្ត។",
    email: "KM-DRAFT: អ៊ីមែល",
    password: "KM-DRAFT: ពាក្យសម្ងាត់",
    code: "KM-DRAFT: លេខកូដផ្ទៀងផ្ទាត់",
    codeHelp:
      "KM-DRAFT: ត្រូវការសម្រាប់ CEO នាយក ប្រធានប្រតិបត្តិការ ហិរញ្ញវត្ថុ និងអ្នកគ្រប់គ្រង និងអ្នកដែលបានបើកការចូលពីរជំហាន។",
    signIn: "KM-DRAFT: ចូល",
    cancel: "KM-DRAFT: បោះបង់",
    consentTitle: "KM-DRAFT: អនុញ្ញាតឱ្យចូលប្រើ DemoQ?",
    consentIntro: "KM-DRAFT: {client} នឹងធ្វើសកម្មភាពជា {name} ក្នុង DemoQ ដោយមានសិទ្ធិដូចអ្នកនៅលើអេក្រង់។",
    redirect: "KM-DRAFT: បន្ទាប់ពីអ្នកឆ្លើយ អ្នកនឹងត្រូវបញ្ជូនទៅ៖",
    asks: "KM-DRAFT: វាស្នើសុំ៖",
    refused: "KM-DRAFT: មិនមានសម្រាប់តួនាទីរបស់អ្នកទេ (អ្នកនឹងទទួលបានតែសិទ្ធិអានប៉ុណ្ណោះ)៖",
    remember: "KM-DRAFT: DemoQ ចងចាំចម្លើយនេះសម្រាប់កម្មវិធីនេះរយៈពេល ៣០ ថ្ងៃ។ រាល់សកម្មភាពត្រូវបានកត់ត្រាក្រោមឈ្មោះរបស់អ្នក។",
    allow: "KM-DRAFT: អនុញ្ញាត",
    deny: "KM-DRAFT: បដិសេធ",
    "scope.read": "KM-DRAFT: អានអ្វីដែលអ្នកអាចមើលឃើញក្នុង DemoQ",
    "scope.write": "KM-DRAFT: ផ្លាស់ប្ដូរអ្វីដែលអ្នកអាចផ្លាស់ប្ដូរក្នុង DemoQ (តែពេលការផ្លាស់ប្ដូរពី Claude ត្រូវបានបើក)",
    "scope.approvals:decide":
      "KM-DRAFT: សម្រេចការអនុម័ត ម្ដងមួយដោយមានការបញ្ជាក់ (មិនដែលសម្រាប់កម្រិតប្រាក់ចំណេញ ការរំលងលក្ខខណ្ឌ ការពិនិត្យការរំលង ការងារអ្នកមានឥទ្ធិពល ឬការទទួលយកការងារក្រៅវិសាលភាព)",
    notEnrolled: "KM-DRAFT: សូមរៀបចំការចូលពីរជំហានក្នុងកម្មវិធី DemoQ ជាមុនសិន រួចព្យាយាមម្ដងទៀត។",
    expired: "KM-DRAFT: សំណើចូលនេះផុតកំណត់ ឬមិនត្រឹមត្រូវ។ សូមចាប់ផ្ដើមម្ដងទៀតពី Claude។",
    otherLang: "English",
  },
};

export const t = (locale: Locale, key: Key, vars: Record<string, string> = {}) =>
  T[locale][key].replace(/^KM-DRAFT:\s*/, "").replace(/\{(\w+)\}/g, (_m, k: string) => esc(vars[k] ?? ""));

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(locale: Locale, title: string, body: string, langHref?: string): string {
  const other = langHref ? `<a class="lang" href="${esc(langHref)}">${t(locale, "otherLang")}</a>` : "";
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${other}<h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export interface LoginView {
  locale: Locale;
  uid: string;
  csrf: string;
  clientName: string;
  email?: string;
  error?: string;
  langHref: string;
}

export function loginPage(v: LoginView): string {
  const L = v.locale;
  return layout(
    L,
    t(L, "signInTitle"),
    `<p>${t(L, "signInIntro", { client: v.clientName })}</p>
${v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : ""}
<form method="post" action="/oauth/interaction/${esc(v.uid)}/login" autocomplete="on">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
<label for="email">${t(L, "email")}</label><input id="email" name="email" type="email" required autocomplete="username" value="${esc(v.email ?? "")}">
<label for="password">${t(L, "password")}</label><input id="password" name="password" type="password" required autocomplete="current-password">
<label for="code">${t(L, "code")}</label><input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
<p class="muted">${t(L, "codeHelp")}</p>
<div class="row"><button class="primary" type="submit">${t(L, "signIn")}</button></div>
</form>
<form method="post" action="/oauth/interaction/${esc(v.uid)}/abort"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><button class="secondary" type="submit">${t(L, "cancel")}</button></form>`,
    v.langHref,
  );
}

export interface ConsentView {
  locale: Locale;
  uid: string;
  csrf: string;
  clientName: string;
  clientId: string;
  userName: string;
  redirectHost: string;
  granted: string[];
  refused: string[];
  langHref: string;
}

export function consentPage(v: ConsentView): string {
  const L = v.locale;
  const scope = (s: string) => `<li><code>${esc(s)}</code> — ${t(L, `scope.${s}` as Key)}</li>`;
  return layout(
    L,
    t(L, "consentTitle"),
    `<p>${t(L, "consentIntro", { client: v.clientName, name: v.userName })}</p>
<p class="muted"><code>${esc(v.clientId)}</code></p>
<p>${t(L, "redirect")} <strong>${esc(v.redirectHost)}</strong></p>
<p>${t(L, "asks")}</p><ul>${v.granted.map(scope).join("")}</ul>
${v.refused.length ? `<p>${t(L, "refused")}</p><ul>${v.refused.map(scope).join("")}</ul>` : ""}
<p class="muted">${t(L, "remember")}</p>
<div class="row">
<form method="post" action="/oauth/interaction/${esc(v.uid)}/consent"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><button class="primary" type="submit">${t(L, "allow")}</button></form>
<form method="post" action="/oauth/interaction/${esc(v.uid)}/abort"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><button class="secondary" type="submit">${t(L, "deny")}</button></form>
</div>`,
    v.langHref,
  );
}

export function messagePage(locale: Locale, message: string): string {
  return layout(locale, "DemoQ", `<p class="err" role="alert">${esc(message)}</p>`);
}
