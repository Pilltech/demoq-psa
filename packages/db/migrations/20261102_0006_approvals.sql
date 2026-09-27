-- Approval engine: one inbox for every kind. Spec: specs/approvals/engine.md (APR-EN-*)

CREATE TABLE approval_policies (
  kind                  text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z_]*$'),
  label_en              text NOT NULL,
  label_km              text NOT NULL,
  required_permission   text NOT NULL,
  -- Ordered chain of roles; escalation walks it (APR-EN-02).
  chain                 text[] NOT NULL CHECK (cardinality(chain) > 0),
  sla_minutes           integer NOT NULL CHECK (sla_minutes > 0),
  fallback_approver_id  uuid REFERENCES users (id),
  channels_allowed      text[] NOT NULL DEFAULT '{web,telegram}',
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_policies_fallback_idx ON approval_policies (fallback_approver_id);

CREATE TABLE approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL REFERENCES approval_policies (kind),
  subject_type         text NOT NULL,
  subject_id           uuid NOT NULL,
  subject_version      integer NOT NULL,
  subject_hash         text NOT NULL,
  requested_by         uuid NOT NULL REFERENCES users (id),
  required_permission  text NOT NULL,
  assignee_id          uuid REFERENCES users (id),
  escalation_level     integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
  due_at               timestamptz NOT NULL,
  decided_by           uuid REFERENCES users (id),
  decided_at           timestamptz,
  decided_channel      text CHECK (decided_channel IN ('web', 'telegram', 'mcp', 'job')),
  decision_note        text,
  snapshot             jsonb NOT NULL DEFAULT '{}'::jsonb,
  on_approve           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"sendQuote": true}
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- APR-EN-04 / INV-17: never self-approved.
  CONSTRAINT approvals_no_self_approval CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
-- APR-EN-01: one pending approval per kind and subject.
CREATE UNIQUE INDEX approvals_one_pending ON approvals (kind, subject_type, subject_id) WHERE status = 'pending';
CREATE INDEX approvals_subject_idx ON approvals (subject_type, subject_id);
CREATE INDEX approvals_assignee_idx ON approvals (assignee_id) WHERE status = 'pending';
CREATE INDEX approvals_due_idx ON approvals (due_at) WHERE status = 'pending';
CREATE INDEX approvals_requested_by_idx ON approvals (requested_by);
CREATE INDEX approvals_decided_by_idx ON approvals (decided_by);

CREATE TABLE approval_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                     bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  approval_id             uuid NOT NULL REFERENCES approvals (id),
  event                   text NOT NULL CHECK (event IN ('created', 'escalated', 'fallback', 'no_eligible', 'approved', 'rejected', 'superseded', 'cancelled')),
  assignee_id             uuid REFERENCES users (id),
  -- APR-EN-03 / INV-18: the router records that each assignee held the permission.
  assignee_permission_ok  boolean,
  actor_name              text NOT NULL,
  channel                 text,
  at                      timestamptz NOT NULL DEFAULT now(),
  CHECK (event NOT IN ('created', 'escalated', 'fallback') OR assignee_id IS NULL OR assignee_permission_ok)
);
CREATE INDEX approval_events_approval_idx ON approval_events (approval_id, seq);
CREATE INDEX approval_events_assignee_idx ON approval_events (assignee_id);
REVOKE UPDATE ON approval_events FROM demoq_app;

-- Step-up (APR-EN-12): when this session last proved TOTP.
ALTER TABLE sessions ADD COLUMN step_up_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_policies', 'approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;
CREATE TRIGGER approval_events_audit AFTER INSERT ON approval_events FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Plan §5.4 defaults (D4, D5). Kinds used from S3/S4 are seeded now so the inbox is one list from day one.
INSERT INTO approval_policies (kind, label_en, label_km, required_permission, chain, sla_minutes, channels_allowed) VALUES
  ('margin_floor',    'Below margin floor', 'ក្រោមកម្រិតប្រាក់ចំណេញ',       'quote.approve_below_floor', '{finance,ops_lead}',            1440, '{web,telegram}'),
  ('out_of_scope',    'Out of scope',       'ក្រៅវិសាលភាព',               'scope.oos.decide',          '{account_lead,ops_lead,director}', 1440, '{web,telegram,mcp}'),
  ('quality_check',   'Quality check',      'ត្រួតពិនិត្យគុណភាព',          'task.quality_approve',      '{team_lead,project_manager,ops_lead}', 480, '{web,telegram,mcp}'),
  ('gate_bypass',     'Gate bypass',        'រំលងលក្ខខណ្ឌ',               'project.bypass.approve',    '{ops_lead,director}',           480, '{web,telegram}'),
  ('bypass_review',   'Monthly bypass review', 'ពិនិត្យការរំលងប្រចាំខែ',   'project.bypass.review',     '{director,ceo}',                7200, '{web}'),
  ('influencer_work', 'Influencer work',    'ការងារអ្នកមានឥទ្ធិពល',        'influencer.work.approve',   '{influencer_manager,project_manager,ops_lead}', 2880, '{web,telegram}'),
  ('leave',           'Leave',              'ច្បាប់ឈប់សម្រាក',             'leave.approve',             '{team_lead,ops_lead,director}', 2880, '{web,telegram,mcp}');
