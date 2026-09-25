// UI strings. Khmer entries marked KM-DRAFT: await the Khmer reviewer; the marker is stripped at render.
import { createContext, useContext, type ReactNode } from "react";
import { errorMessage, formatMoney, type ErrorCode, type Locale } from "@demoq/shared";

const en = {
  appName: "DemoQ PSA",
  signIn: "Sign in",
  email: "Email",
  password: "Password",
  signOut: "Sign out",
  totpEnrollTitle: "Set up two-step sign-in",
  totpEnrollHelp:
    "Your role needs a second step. Scan this code with Google Authenticator or Microsoft Authenticator, then enter the 6-digit code.",
  totpVerifyTitle: "Two-step sign-in",
  totpCode: "6-digit code",
  totpManual: "Can't scan? Enter this key:",
  verify: "Verify",
  pipeline: "Pipeline",
  clients: "Clients",
  client: "Client",
  close: "Close",
  admin: "Admin",
  search: "Search",
  newClient: "New client",
  newDeal: "New deal",
  name: "Name",
  nameKm: "Name (Khmer)",
  industry: "Industry",
  accountLead: "Account lead",
  save: "Save",
  cancel: "Cancel",
  create: "Create",
  contacts: "Contacts",
  addContact: "Add contact",
  fullName: "Full name",
  title: "Title",
  phone: "Phone",
  telegram: "Telegram",
  primary: "Primary",
  deals: "Deals",
  dealTitle: "Deal title",
  expectedValue: "Expected value",
  currency: "Currency",
  owner: "Owner",
  stage: "Stage",
  history: "History",
  auditTrail: "Audit trail",
  noItems: "Nothing here yet.",
  closeAsLost: "Close as lost",
  closeReason: "Reason",
  chooseReason: "Choose a reason…",
  note: "Note (optional)",
  confirmLost: "Close as lost",
  reopen: "Reopen",
  reopenReason: "Why reopen? (at least 10 characters)",
  moveTo: "Move to",
  loading: "Loading…",
  users: "Users",
  teams: "Teams",
  newUser: "New user",
  newTeam: "New team",
  roles: "Roles",
  initialPassword: "Initial password (12+ characters)",
  team: "Team",
  none: "—",
  language: "ខ្មែរ",
  "stage.lead": "Lead",
  "stage.qualified": "Qualified",
  "stage.proposal": "Proposal",
  "stage.negotiation": "Negotiation",
  "stage.won": "Won",
  "stage.lost": "Lost",
  byOn: "by {who} · {when} · {channel}",
  saved: "Saved",
  archived: "Archived",
  poRequired: "PO required",
  wonHint: "Won comes from accepting the quote (quotes arrive in the next release).",
};
type Key = keyof typeof en;

const km: Record<Key, string> = {
  appName: "DemoQ PSA",
  signIn: "KM-DRAFT: ចូលគណនី",
  email: "KM-DRAFT: អ៊ីមែល",
  password: "KM-DRAFT: ពាក្យសម្ងាត់",
  signOut: "KM-DRAFT: ចាកចេញ",
  totpEnrollTitle: "KM-DRAFT: រៀបចំការចូលពីរជំហាន",
  totpEnrollHelp:
    "KM-DRAFT: តួនាទីរបស់អ្នកត្រូវការជំហានទីពីរ។ ស្កេនកូដនេះដោយ Google Authenticator ឬ Microsoft Authenticator រួចបញ្ចូលលេខកូដ ៦ ខ្ទង់។",
  totpVerifyTitle: "KM-DRAFT: ការចូលពីរជំហាន",
  totpCode: "KM-DRAFT: លេខកូដ ៦ ខ្ទង់",
  totpManual: "KM-DRAFT: ស្កេនមិនបាន? បញ្ចូលកូដនេះ៖",
  verify: "KM-DRAFT: ផ្ទៀងផ្ទាត់",
  pipeline: "KM-DRAFT: បំពង់លក់",
  clients: "KM-DRAFT: អតិថិជន",
  client: "KM-DRAFT: អតិថិជន",
  close: "KM-DRAFT: បិទ",
  admin: "KM-DRAFT: រដ្ឋបាល",
  search: "KM-DRAFT: ស្វែងរក",
  newClient: "KM-DRAFT: អតិថិជនថ្មី",
  newDeal: "KM-DRAFT: កិច្ចព្រមព្រៀងថ្មី",
  name: "KM-DRAFT: ឈ្មោះ",
  nameKm: "KM-DRAFT: ឈ្មោះ (ខ្មែរ)",
  industry: "KM-DRAFT: វិស័យ",
  accountLead: "KM-DRAFT: អ្នកទទួលខុសត្រូវគណនី",
  save: "KM-DRAFT: រក្សាទុក",
  cancel: "KM-DRAFT: បោះបង់",
  create: "KM-DRAFT: បង្កើត",
  contacts: "KM-DRAFT: អ្នកទំនាក់ទំនង",
  addContact: "KM-DRAFT: បន្ថែមអ្នកទំនាក់ទំនង",
  fullName: "KM-DRAFT: ឈ្មោះពេញ",
  title: "KM-DRAFT: តួនាទី",
  phone: "KM-DRAFT: ទូរស័ព្ទ",
  telegram: "Telegram",
  primary: "KM-DRAFT: ចម្បង",
  deals: "KM-DRAFT: កិច្ចព្រមព្រៀង",
  dealTitle: "KM-DRAFT: ចំណងជើងកិច្ចព្រមព្រៀង",
  expectedValue: "KM-DRAFT: តម្លៃរំពឹងទុក",
  currency: "KM-DRAFT: រូបិយប័ណ្ណ",
  owner: "KM-DRAFT: ម្ចាស់",
  stage: "KM-DRAFT: ដំណាក់កាល",
  history: "KM-DRAFT: ប្រវត្តិ",
  auditTrail: "KM-DRAFT: កំណត់ត្រាសវនកម្ម",
  noItems: "KM-DRAFT: មិនទាន់មានអ្វីនៅឡើយ។",
  closeAsLost: "KM-DRAFT: បិទថាចាញ់",
  closeReason: "KM-DRAFT: មូលហេតុ",
  chooseReason: "KM-DRAFT: ជ្រើសរើសមូលហេតុ…",
  note: "KM-DRAFT: កំណត់សម្គាល់ (ស្រេចចិត្ត)",
  confirmLost: "KM-DRAFT: បិទថាចាញ់",
  reopen: "KM-DRAFT: បើកឡើងវិញ",
  reopenReason: "KM-DRAFT: ហេតុអ្វីបើកឡើងវិញ? (យ៉ាងតិច ១០ តួអក្សរ)",
  moveTo: "KM-DRAFT: ផ្លាស់ទៅ",
  loading: "KM-DRAFT: កំពុងផ្ទុក…",
  users: "KM-DRAFT: អ្នកប្រើប្រាស់",
  teams: "KM-DRAFT: ក្រុម",
  newUser: "KM-DRAFT: អ្នកប្រើប្រាស់ថ្មី",
  newTeam: "KM-DRAFT: ក្រុមថ្មី",
  roles: "KM-DRAFT: តួនាទី",
  initialPassword: "KM-DRAFT: ពាក្យសម្ងាត់ដំបូង (១២ តួអក្សរឡើងទៅ)",
  team: "KM-DRAFT: ក្រុម",
  none: "—",
  language: "English",
  "stage.lead": "KM-DRAFT: អតិថិជនសក្តានុពល",
  "stage.qualified": "KM-DRAFT: មានលក្ខណៈសម្បត្តិ",
  "stage.proposal": "KM-DRAFT: សំណើ",
  "stage.negotiation": "KM-DRAFT: ចរចា",
  "stage.won": "KM-DRAFT: ឈ្នះ",
  "stage.lost": "KM-DRAFT: ចាញ់",
  byOn: "KM-DRAFT: ដោយ {who} · {when} · {channel}",
  saved: "KM-DRAFT: បានរក្សាទុក",
  archived: "KM-DRAFT: បានទុកក្នុងបណ្ណសារ",
  poRequired: "KM-DRAFT: ត្រូវការ PO",
  wonHint: "KM-DRAFT: ការឈ្នះកើតឡើងពេលទទួលយកសម្រង់តម្លៃ (សម្រង់តម្លៃនឹងមកក្នុងកំណែបន្ទាប់)។",
};

const dict: Record<Locale, Record<Key, string>> = { en, km };
const strip = (s: string) => s.replace(/^KM-DRAFT:\s*/, "");

export interface I18n {
  locale: Locale;
  t: (k: Key, vars?: Record<string, string>) => string;
  err: (code: ErrorCode) => string;
  money: (minor: string | null, currency: "USD" | "KHR") => string;
  date: (iso: string) => string;
}

export function makeI18n(locale: Locale): I18n {
  return {
    locale,
    t: (k, vars) => {
      let s = strip(dict[locale][k] ?? en[k]);
      for (const [name, v] of Object.entries(vars ?? {})) s = s.replace(`{${name}}`, v);
      return s;
    },
    err: (code) => errorMessage(code, locale),
    money: (minor, currency) => (minor === null ? "—" : formatMoney({ amountMinor: BigInt(minor), currency }, locale)),
    date: (iso) =>
      new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Phnom_Penh",
      }).format(new Date(iso)),
  };
}

const Ctx = createContext<I18n>(makeI18n("en"));
export const I18nProvider = ({ value, children }: { value: I18n; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
);
export const useI18n = () => useContext(Ctx);
