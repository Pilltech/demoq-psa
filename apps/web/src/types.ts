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
export type QuoteStatus =
  "draft" | "margin_review" | "ready" | "sent" | "accepted" | "rejected" | "expired" | "superseded" | "submitted";
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
  /** Out-of-scope decisions only (APR-EN-13). */
  outcome?: OosOutcome | null;
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

// ---- S3: projects, gates, bypasses, scope, change orders, tasks (shapes mirror core's queries) ----
export type ProjectStatus = "gated" | "active" | "on_hold" | "completed" | "cancelled";
export type Gate = "scope" | "contract" | "quote" | "purchase_order" | "deposit_terms";
export type GateState = "missing" | "satisfied" | "not_applicable";
export const GATE_ORDER: Gate[] = ["scope", "quote", "contract", "purchase_order", "deposit_terms"];
/** Gates a person satisfies with evidence (scope and quote come from the acceptance). */
export const EVIDENCE_GATES: Gate[] = ["contract", "purchase_order", "deposit_terms"];
export interface ProjectRow {
  id: string;
  name: string;
  kind: "client" | "internal";
  status: ProjectStatus;
  planned_start: string;
  client_id: string | null;
  client_name: string | null;
  pm_id: string;
  pm_name: string;
  version: number;
  /** Missing gates not covered by an open bypass. */
  missingGates: Gate[];
}
export interface ProjectGate {
  gate: Gate;
  status: GateState;
  evidence: string | null;
  satisfied_at: string | null;
  satisfied_by_name: string | null;
  exemption_reason: string | null;
  exemption_decided_by_name: string | null;
  exemption_decided_at: string | null;
}
export type BypassStatus = "requested" | "open" | "rejected" | "closed";
export interface Bypass {
  id: string;
  gates: Gate[];
  status: BypassStatus;
  reason: string;
  expires_at: string;
  close_cause: string | null;
  owner_name: string;
  created_at: string;
}
export interface ScopeItemRow {
  id: string;
  kind: LineKind;
  service_code: string | null;
  description_en: string;
  description_km: string | null;
  qty_milli: number;
  line_price_minor: string;
  quoted_minutes: number | null;
  scope_period_id: string | null;
  source_type: "quote" | "change_order" | "retainer_period";
}
export interface ProjectDetail {
  id: string;
  kind: "client" | "internal";
  name: string;
  client_id: string | null;
  deal_id: string | null;
  quote_id: string | null;
  scope_id: string | null;
  project_type_id: string;
  engagement_type_id: string | null;
  planned_start: string;
  pm_id: string;
  status: ProjectStatus;
  activated_at: string | null;
  version: number;
  client_name: string | null;
  pm_name: string;
  project_type_en: string;
  project_type_km: string;
  gates: ProjectGate[];
  gateStatus: { missing: Gate[]; uncovered: Gate[] };
  members: { user_id: string; project_role: string; display_name: string }[];
  bypasses: Bypass[];
  scopeItems: ScopeItemRow[];
  taskCounts: Partial<Record<TaskStatus, number>>;
  canManage: boolean;
  canSatisfyGates: boolean;
  canActivate: boolean;
  canRequestBypass: boolean;
}
export interface ScopePeriod {
  id: string;
  period_no: number;
  period_start: string;
  period_end: string;
  status: "upcoming" | "active" | "closed";
}
export interface ScopeDetail {
  id: string;
  currency: Currency;
  billingModel: BillingModel;
  periodMonths: number | null;
  startsOn: string;
  valueMinor: string;
  periods: ScopePeriod[];
  items: (ScopeItemRow & { unit_price_minor: string; source_id: string })[];
}
export type CoStatus = "draft" | "margin_review" | "ready" | "sent" | "accepted" | "rejected" | "void" | "submitted";
export interface ChangeOrderLine {
  kind: LineKind;
  rateCardItemId: string | null;
  descriptionEn: string;
  descriptionKm: string | null;
  serviceCode: string | null;
  qtyMilli: number;
  unitPriceMinor: string;
  listPriceMinor: string | null;
  discountBp: number;
  linePriceMinor: string;
  quotedMinutes: number | null;
  unitCostMinor: string | null;
  lineCostMinor: string | null;
}
export interface ChangeOrder {
  id: string;
  projectId: string;
  number: number;
  title: string;
  currency: Currency;
  scopePeriodId: string | null;
  status: CoStatus;
  feePriceMinor: string;
  ptPriceMinor: string;
  discountMinor: string;
  totalMinor: string;
  sentAt: string | null;
  acceptedAt: string | null;
  version: number;
  /** null unless the viewer holds finance.view_costs for this client (COM-QB-04). */
  costs: QuoteCosts | null;
}
export interface ChangeOrderDetail extends ChangeOrder {
  lines: ChangeOrderLine[];
  canEdit: boolean;
  canManage: boolean;
}
export type TaskStatus = "todo" | "in_progress" | "internal_review" | "client_ready" | "client_review" | "done" | "cancelled";
/** TSK-DL-12: what the viewer may do next (the server decides; the board shows only these buttons). */
export type TaskAction =
  "start" | "stop" | "finish" | "submit_qc" | "mark_sent" | "request_revision" | "client_accept" | "cancel";
export type OosOutcome = "absorb" | "change_order" | "reject";
export interface Task {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  owner_id: string;
  owner_name: string;
  estimate_minutes: number;
  due_date: string;
  status: TaskStatus;
  scope_item_id: string | null;
  non_deliverable: boolean;
  oos_status: "none" | "pending" | "approved" | "rejected";
  client_facing: boolean;
  version: number;
  dependsOn: string[];
  blockedByDependencies: boolean;
  /** task.board only: the viewer owns it and may move it. */
  canMove?: boolean;
  // ---- S4 delivery (specs/tasks/delivery.md, TSK-DL-12) ----
  revision_round: number;
  oos_decision: OosOutcome | null;
  sent_to_client_at: string | null;
  sent_reference: string | null;
  qc: { approvalId: string; status: ApprovalStatus; canDecide: boolean } | null;
  qcStatus: ApprovalStatus | "none";
  revisionRequest: {
    approvalId: string;
    status: ApprovalStatus;
    outcome: OosOutcome | null;
    note: string | null;
    reworkMinutes: number | null;
  } | null;
  nextRevision: "normal" | "out_of_scope" | "hard_stop" | null;
  actions: TaskAction[];
}
export interface TaskRound {
  round: number;
  kind: "internal" | "client";
  quality_approval_id: string | null;
  oos_approval_id: string | null;
  rework_minutes: number | null;
  note: string | null;
  requested_by_name: string;
  created_at: string;
  approval_status: ApprovalStatus | null;
}
export interface TaskDetail extends Task {
  description: string | null;
  started_at: string | null;
  done_at: string | null;
  rounds: TaskRound[];
}
export interface TaskBoardData {
  project: { id: string; pm_id: string; kind: "client" | "internal"; status: ProjectStatus; name: string };
  canManage: boolean;
  tasks: Task[];
}
export interface TemplateItem {
  key: string;
  title_en: string;
  title_km: string | null;
  role_hint: string | null;
  offset_days: number;
  estimate_minutes: number;
  depends_on_keys: string[];
  service_code: string | null;
  client_facing: boolean;
}
export interface TemplateEntry {
  projectType: { id: string; code: string; label_en: string; label_km: string; active: boolean };
  template: { id: string; name: string; version: number; items: TemplateItem[] } | null;
}

// ---- S4: attendance, timesheets, leave, holidays (shapes mirror core/src/time) ----------------------
export interface AttendanceSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  channel: string;
  autoClosed: boolean;
  flagged: boolean;
  flagReason: string | null;
  version: number;
}
export interface AttendanceStatus {
  today: string;
  weekStart: string;
  running: (AttendanceSession & { autoCloseAt: string }) | null;
  todayMinutes: number;
  weekMinutes: number;
  flaggedThisWeek: number;
  sessionsToday: AttendanceSession[];
}
export type TargetType = "task" | "project" | "deal" | "internal";
export interface WeekDay {
  date: string;
  weekday: number;
  scheduled: boolean;
  holiday: { nameEn: string; nameKm: string; verified: boolean } | null;
  leave: { id: string; leaveType: string; halfDay: "am" | "pm" | null } | null;
  workingDay: boolean;
  capacityMinutes: number;
  attendedMinutes: number;
  baseMinutes: number | null;
  allocatedMinutes: number;
  flaggedSessions: number;
  runningSession: boolean;
}
export interface WeekTarget {
  targetType: TargetType;
  taskId: string | null;
  projectId: string | null;
  dealId: string | null;
  activityCode: string | null;
  key: string;
  label: string;
  labelKm: string | null;
  projectName: string | null;
  projectKind: "client" | "internal" | null;
  minutesByDate: Record<string, number>;
  totalMinutes: number;
}
export interface WeekRowDto {
  date: string;
  targetType: TargetType;
  targetId: string | null;
  taskId: string | null;
  projectId: string | null;
  dealId: string | null;
  activityCode: string | null;
  key: string;
  minutes: number;
  source: "prefill" | "manual" | "mcp" | "telegram";
  status: "draft" | "confirmed" | "proposed";
}
export interface WeekView {
  userId: string;
  weekStart: string;
  weekEnd: string;
  status: "open" | "confirmed";
  version: number;
  openedAt: string | null;
  confirmedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  prefillBasis: "last_week" | "open_tasks" | "admin" | "none";
  days: WeekDay[];
  targets: WeekTarget[];
  rows: WeekRowDto[];
  totals: { attendedMinutes: number; allocatedMinutes: number; prefillMinutes: number; flaggedSessions: number };
  draftHash: string;
}
export interface TeamWeekPerson {
  userId: string;
  name: string;
  teamId: string | null;
  status: "open" | "confirmed";
  openedAt: string | null;
  confirmedAt: string | null;
  remindedAt: string | null;
  escalatedAt: string | null;
  reopenCount: number;
  attendedMinutes: number;
  allocatedMinutes: number;
  flaggedSessions: number;
}
export interface TeamWeek {
  weekStart: string;
  confirmedCount: number;
  people: TeamWeekPerson[];
  metrics: {
    confirmedMinutes: number;
    prefillKeptMinutes: number;
    prefillKeptRatio: number | null;
    medianConfirmSeconds: number | null;
  };
}
export interface ActivityCode {
  code: string;
  labelEn: string;
  labelKm: string;
  active: boolean;
  position: number;
  version: number;
}
export interface Holiday {
  date: string;
  nameEn: string;
  nameKm: string;
  source: string;
  verified: boolean;
  verifiedAt: string | null;
  version: number;
}
export type LeaveStatus = "requested" | "approved" | "rejected" | "cancelled";
export interface LeaveRequest {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay: "am" | "pm" | null;
  reason: string | null;
  status: LeaveStatus;
  approvalId: string | null;
  version: number;
}
export interface LeaveType {
  code: string;
  labelEn: string;
  labelKm: string;
  paid: boolean;
  halfDayAllowed: boolean;
}

// ---- S4: influencers (shapes mirror core/src/influencers) --------------------------------------------
export interface InfluencerHandle {
  platform: string;
  handle: string;
}
export interface Influencer {
  id: string;
  displayName: string;
  handles: InfluencerHandle[];
  active: boolean;
  version: number;
  /** Roster managers only (INF-RS-01). */
  phone?: string | null;
  telegram?: string | null;
  notes?: string | null;
}
export interface Assignment {
  id: string;
  influencerId: string;
  influencer: string;
  scopeItemId: string;
  deliverable: { en: string; km: string | null };
  contractedPosts: number;
  perPostPassthroughMinor: string | null;
  currency: Currency | null;
  notes: string | null;
  active: boolean;
  version: number;
}
export type LinkState = "active" | "expired" | "revoked" | "exhausted";
export interface WorkLink {
  id: string;
  state: LinkState;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  maxSubmissions: number;
  used: number;
  remaining: number;
  revokedAt: string | null;
  revokeReason: string | null;
}
export type WorkStatus = "submitted" | "approved" | "rejected";
export interface WorkLog {
  id: string;
  assignmentId: string;
  influencer: string;
  postUrl: string;
  postedOn: string;
  metrics: Record<string, number>;
  proofUrls: string[];
  note: string | null;
  status: WorkStatus;
  overQuantity: boolean;
  oosOutcome: OosOutcome | null;
  approvalId: string | null;
  oosApprovalId: string | null;
  submittedAt: string;
  decidedAt: string | null;
}
export interface WorkSummary {
  assignmentId: string;
  influencer: string;
  deliverable: { en: string; km: string | null };
  active: boolean;
  contractedPosts: number;
  approved: number;
  approvedOverQuantity: number;
  pending: number;
  rejected: number;
  outstanding: number;
}
