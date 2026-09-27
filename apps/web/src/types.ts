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

// ---- S2: commercial, approvals, profile (shapes mirror core's quoteDto and approval toDto) ----
export type Currency = "USD" | "KHR";
export type QuoteStatus = "draft" | "margin_review" | "ready" | "sent" | "accepted" | "rejected" | "expired" | "superseded";
export type LineKind = "fee" | "pass_through";
export type BillingModel = "one_off" | "retainer";
export type Unit = "hour" | "day" | "item" | "post" | "month" | "lump";
export type CommercialModel = "retainer" | "campaign" | "one_off" | "influencer_program";

export interface EngagementType {
  id: string;
  code: string;
  label_en: string;
  label_km: string;
  commercial_model: CommercialModel;
  fee_margin_floor_bp: number;
  passthrough_markup_floor_bp: number | null;
  passthrough_markup_warn_bp: number;
  active: boolean;
  version: number;
}
export interface ProjectType {
  id: string;
  code: string;
  label_en: string;
  label_km: string;
  default_engagement_type_id: string;
  active: boolean;
  version: number;
}
export interface RateCard {
  id: string;
  name: string;
  currency: Currency;
  active: boolean;
  version: number;
}
export interface RateCardItem {
  id: string;
  rate_card_id: string;
  service_code: string;
  kind: LineKind;
  label_en: string;
  label_km: string;
  unit: Unit;
  unit_price_minor: string;
  /** null unless the viewer holds finance.view_costs (COM-CF-04). */
  unit_cost_minor: string | null;
  active: boolean;
  version: number;
}
export interface RateCardDetail extends RateCard {
  items: RateCardItem[];
}
export interface FxRate {
  id: string;
  rate_date: string;
  rate_micros: string;
  source: string;
  updated_at: string;
}
export interface QuoteLine {
  kind: LineKind;
  rateCardItemId: string | null;
  serviceCode: string | null;
  descriptionEn: string;
  descriptionKm: string | null;
  qtyMilli: number;
  unitPriceMinor: string;
  listPriceMinor: string | null;
  discountBp: number;
  linePriceMinor: string;
  perPeriod: boolean;
  quotedMinutes: number | null;
  unitCostMinor: string | null;
  lineCostMinor: string | null;
}
export interface QuoteCosts {
  feeCostMinor: string;
  ptCostMinor: string;
  feeMarginBp: number | null;
  ptMarkupBp: number | null;
  belowFloor: boolean;
}
export interface QuoteSummary {
  id: string;
  dealId: string;
  clientId: string;
  ownerId: string;
  versionNo: number;
  title: string;
  status: QuoteStatus;
  currency: Currency;
  billingModel: BillingModel;
  periodMonths: number | null;
  engagementTypeId: string;
  projectTypeId: string | null;
  rateCardId: string | null;
  validUntil: string | null;
  terms: string | null;
  feePriceMinor: string;
  ptPriceMinor: string;
  discountMinor: string;
  totalMinor: string;
  sendOnApproval: boolean;
  sentAt: string | null;
  fxRateMicros: string | null;
  fxRateDate: string | null;
  pdfStatus: string | null;
  rejectedReason: string | null;
  version: number;
  canEdit: boolean;
  canSend: boolean;
  /** null for actors without finance.view_costs on this quote (COM-QB-04). */
  costs: QuoteCosts | null;
}
export interface Floors {
  feeMarginFloorBp: number;
  passthroughMarkupFloorBp: number | null;
  passthroughMarkupWarnBp: number;
}
export interface QuoteDetail extends QuoteSummary {
  lines: QuoteLine[];
  floors: (Floors & { label: string }) | null;
  approval: { id: string; status: ApprovalStatus } | null;
}
export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded" | "cancelled";
export interface Approval {
  id: string;
  kind: string;
  status: ApprovalStatus;
  subjectType: string;
  subjectId: string;
  title: string;
  facts: Record<string, unknown>;
  /** Only for finance.view_costs holders (APR-EN-11). */
  costs: Record<string, unknown> | null;
  requestedBy: string | null;
  assignee: string | null;
  assignedToMe: boolean;
  canDecide: boolean;
  mine: boolean;
  dueAt: string;
  overdue: boolean;
  escalationLevel: number;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  version: number;
}
export interface ApiToken {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}
export interface Profile {
  telegramLinked: boolean;
  tokens: ApiToken[];
  readOnlyTokens: boolean;
}
