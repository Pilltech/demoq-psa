export type Stage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
export interface Deal {
  id: string;
  title: string;
  stage: Stage;
  client_id: string;
  client_name: string;
  client_name_km: string | null;
  owner_id: string;
  owner_name: string;
  expected_value_minor: string | null;
  currency: "USD" | "KHR";
  expected_close_on: string | null;
  close_reason_code: string | null;
  close_note: string | null;
  version: number;
  canManage: boolean;
}
export interface DealDetail extends Deal {
  history: {
    from_stage: Stage | null;
    to_stage: Stage;
    close_reason_code: string | null;
    note: string | null;
    changed_at: string;
    changed_by_name: string | null;
  }[];
  canReopen: boolean;
}
export interface CloseReason {
  code: string;
  kind: "won" | "lost";
  label_en: string;
  label_km: string;
}
export interface ClientRow {
  id: string;
  name: string;
  name_km: string | null;
  industry: string | null;
  account_lead_id: string;
  account_lead_name: string;
  archived_at: string | null;
  version: number;
}
export interface Contact {
  id: string;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  telegram: string | null;
  is_primary: boolean;
  version: number;
}
export interface ClientDetail extends ClientRow {
  team_id: string | null;
  po_required: boolean;
  contacts: Contact[];
  deals: { id: string; title: string; stage: Stage; version: number }[] | null;
  canManage: boolean;
}
export interface AuditRow {
  id: string;
  occurred_at: string;
  action: string;
  actor_name: string;
  channel: string;
  outcome: string;
}
export interface DirectoryUser {
  id: string;
  displayName: string;
  displayNameKm: string | null;
  teamId: string | null;
  email: string;
  roles: string[];
  version: number;
}
