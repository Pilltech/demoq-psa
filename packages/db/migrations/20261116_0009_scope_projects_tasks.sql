-- Sprint 3: scope, retainer periods, change orders, projects, gates, bypasses, tasks, templates, giveaway ledger.
-- Specs: specs/commercial/{accept-scope,change-orders,retainers}.md, specs/projects/*.md, specs/tasks/tasks.md,
--        specs/reporting/giveaway.md

ALTER TABLE clients ADD COLUMN per_period_gates boolean NOT NULL DEFAULT false;  -- D21 (enforced from S4)

-- PRJ-GT-03 / INV-21: a PO gate is waived only by a recorded Finance/Ops exemption.
CREATE TABLE client_gate_exemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients (id),
  gate         text NOT NULL CHECK (gate = 'purchase_order'),
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 10),
  decided_by   uuid NOT NULL REFERENCES users (id),
  decided_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_gate_exemptions_active ON client_gate_exemptions (client_id, gate) WHERE revoked_at IS NULL;
CREATE INDEX client_gate_exemptions_decided_by_idx ON client_gate_exemptions (decided_by);

-- ---------------------------------------------------------------------------------------------------------------
-- Scope (COM-AC-03, COM-CO-04, COM-RT-*): insert-only items.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE scopes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL UNIQUE REFERENCES quotes (id),
  client_id      uuid NOT NULL REFERENCES clients (id),
  currency       char(3) NOT NULL CHECK (currency IN ('USD', 'KHR')),
  fx_rate_micros bigint NOT NULL CHECK (fx_rate_micros > 0),
  billing_model  text NOT NULL CHECK (billing_model IN ('one_off', 'retainer')),
  period_months  integer CHECK (period_months BETWEEN 1 AND 36),
  starts_on      date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((billing_model = 'retainer') = (period_months IS NOT NULL))
);
CREATE INDEX scopes_client_idx ON scopes (client_id);
REVOKE UPDATE ON scopes FROM demoq_app;

CREATE TABLE scope_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id      uuid NOT NULL REFERENCES scopes (id),
  period_no     integer NOT NULL CHECK (period_no >= 1),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, period_start),
  UNIQUE (scope_id, period_no),
  CHECK (period_end >= period_start)
);

CREATE TABLE scope_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id          uuid NOT NULL REFERENCES scopes (id),
  scope_period_id   uuid REFERENCES scope_periods (id),
  source_type       text NOT NULL CHECK (source_type IN ('quote', 'change_order', 'retainer_period')),
  source_id         uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('fee', 'pass_through')),
  service_code      text,
  description_en    text NOT NULL,
  description_km    text,
  qty_milli         integer NOT NULL CHECK (qty_milli > 0),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_price_minor  bigint NOT NULL CHECK (line_price_minor >= 0),
  quoted_minutes    integer CHECK (quoted_minutes >= 0),
  per_period        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scope_items_scope_idx ON scope_items (scope_id);
CREATE INDEX scope_items_period_idx ON scope_items (scope_period_id);
REVOKE UPDATE ON scope_items FROM demoq_app;

CREATE FUNCTION insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INSERT_ONLY: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER scope_items_insert_only BEFORE UPDATE OR DELETE ON scope_items FOR EACH ROW EXECUTE FUNCTION insert_only();
CREATE TRIGGER scopes_insert_only BEFORE UPDATE OR DELETE ON scopes FOR EACH ROW EXECUTE FUNCTION insert_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Projects and gates (PRJ-PJ-*, PRJ-GT-*)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('client', 'internal')),
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  client_id           uuid REFERENCES clients (id),
  deal_id             uuid REFERENCES deals (id),
  quote_id            uuid UNIQUE REFERENCES quotes (id),
  scope_id            uuid UNIQUE REFERENCES scopes (id),
  project_type_id     uuid NOT NULL REFERENCES project_types (id),
  engagement_type_id  uuid REFERENCES engagement_types (id),
  planned_start       date NOT NULL,
  pm_id               uuid NOT NULL REFERENCES users (id),
  status              text NOT NULL CHECK (status IN ('gated', 'active', 'on_hold', 'completed', 'cancelled')),
  activated_at        timestamptz,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'internal' OR (client_id IS NOT NULL AND scope_id IS NOT NULL AND engagement_type_id IS NOT NULL))
);
CREATE INDEX projects_client_idx ON projects (client_id);
CREATE INDEX projects_deal_idx ON projects (deal_id);
CREATE INDEX projects_type_idx ON projects (project_type_id);
CREATE INDEX projects_engagement_idx ON projects (engagement_type_id);
CREATE INDEX projects_pm_idx ON projects (pm_id);
CREATE INDEX projects_status_idx ON projects (status);

CREATE TABLE project_members (
  project_id    uuid NOT NULL REFERENCES projects (id),
  user_id       uuid NOT NULL REFERENCES users (id),
  project_role  text NOT NULL CHECK (project_role ~ '^[a-z][a-z_]*$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);
GRANT DELETE ON project_members TO demoq_app;

CREATE TABLE project_gates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id),
  gate          text NOT NULL CHECK (gate IN ('scope', 'contract', 'quote', 'purchase_order', 'deposit_terms')),
  status        text NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'satisfied', 'not_applicable')),
  evidence      text,
  exemption_id  uuid REFERENCES client_gate_exemptions (id),
  satisfied_by  uuid REFERENCES users (id),
  satisfied_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, gate),
  CHECK (status <> 'satisfied' OR (evidence IS NOT NULL AND length(btrim(evidence)) >= 3 AND satisfied_at IS NOT NULL)),
  -- PRJ-GT-03 backstop: not_applicable only for the PO gate, only through an exemption.
  CONSTRAINT project_gates_exemption_required CHECK (status <> 'not_applicable' OR (gate = 'purchase_order' AND exemption_id IS NOT NULL))
);
CREATE INDEX project_gates_exemption_idx ON project_gates (exemption_id);
CREATE INDEX project_gates_satisfied_by_idx ON project_gates (satisfied_by);

CREATE TABLE gate_bypasses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id),
  gates           text[] NOT NULL CHECK (cardinality(gates) > 0 AND gates <@ ARRAY['scope', 'contract', 'quote', 'purchase_order', 'deposit_terms']),
  named_owner_id  uuid NOT NULL REFERENCES users (id),
  reason          text NOT NULL,
  requested_by    uuid NOT NULL REFERENCES users (id),
  approval_id     uuid REFERENCES approvals (id),
  approved_by     uuid REFERENCES users (id),
  approved_at     timestamptz,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'open', 'closed', 'rejected')),
  expires_at      timestamptz NOT NULL,
  legacy          boolean NOT NULL DEFAULT false,
  close_cause     text CHECK (close_cause IN ('gates_met', 'expired', 'revoked')),
  closed_at       timestamptz,
  review_month    date,
  review_outcome  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- PRJ-BP-06 / INV-07
  CONSTRAINT gate_bypasses_reason CHECK (length(btrim(reason)) >= 30),
  CONSTRAINT gate_bypasses_expiry CHECK (expires_at <= created_at + CASE WHEN legacy THEN interval '60 days' ELSE interval '30 days' END),
  CONSTRAINT gate_bypasses_approved_by_human CHECK (status NOT IN ('open', 'closed') OR (approved_by IS NOT NULL AND approved_by <> requested_by)),
  CHECK ((status = 'closed') = (close_cause IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX gate_bypasses_project_idx ON gate_bypasses (project_id);
CREATE INDEX gate_bypasses_open_idx ON gate_bypasses (expires_at) WHERE status = 'open';
CREATE INDEX gate_bypasses_owner_idx ON gate_bypasses (named_owner_id);
CREATE INDEX gate_bypasses_requested_by_idx ON gate_bypasses (requested_by);
CREATE INDEX gate_bypasses_approved_by_idx ON gate_bypasses (approved_by);
CREATE INDEX gate_bypasses_approval_idx ON gate_bypasses (approval_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Task templates and tasks (TSK-*)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE task_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_type_id  uuid NOT NULL UNIQUE REFERENCES project_types (id),
  name             text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_template_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES task_templates (id),
  key               text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  position          integer NOT NULL CHECK (position >= 0),
  title_en          text NOT NULL,
  title_km          text,
  role_hint         text,
  offset_days       integer NOT NULL CHECK (offset_days BETWEEN 0 AND 365),
  estimate_minutes  integer NOT NULL CHECK (estimate_minutes > 0),
  depends_on_keys   text[] NOT NULL DEFAULT '{}',
  service_code      text,
  client_facing     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, key),
  UNIQUE (template_id, position)
);
GRANT DELETE ON task_template_items TO demoq_app;

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id),
  title             text NOT NULL CHECK (length(btrim(title)) > 0),
  description       text,
  owner_id          uuid NOT NULL REFERENCES users (id),
  estimate_minutes  integer NOT NULL CHECK (estimate_minutes > 0),
  estimate_source   text NOT NULL DEFAULT 'manual' CHECK (estimate_source IN ('template', 'manual', 'change_order', 'legacy')),
  due_date          date NOT NULL,
  status            text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  scope_item_id     uuid REFERENCES scope_items (id),
  non_deliverable   boolean NOT NULL DEFAULT false,
  oos_approval_id   uuid REFERENCES approvals (id),
  oos_status        text NOT NULL DEFAULT 'none' CHECK (oos_status IN ('none', 'pending', 'approved', 'rejected')),
  client_facing     boolean NOT NULL DEFAULT false,
  template_item_id  uuid REFERENCES task_template_items (id),
  rank              integer NOT NULL DEFAULT 0,
  started_at        timestamptz,
  done_at           timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (oos_status = 'none' OR oos_approval_id IS NOT NULL)
);
CREATE INDEX tasks_project_idx ON tasks (project_id, status);
CREATE INDEX tasks_owner_idx ON tasks (owner_id, status);
CREATE INDEX tasks_scope_item_idx ON tasks (scope_item_id);
CREATE INDEX tasks_oos_approval_idx ON tasks (oos_approval_id);
CREATE INDEX tasks_template_item_idx ON tasks (template_item_id);

CREATE TABLE task_dependencies (
  task_id        uuid NOT NULL REFERENCES tasks (id),
  depends_on_id  uuid NOT NULL REFERENCES tasks (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_id),
  CONSTRAINT task_dependencies_not_self CHECK (task_id <> depends_on_id)
);
CREATE INDEX task_dependencies_depends_on_idx ON task_dependencies (depends_on_id);
GRANT DELETE ON task_dependencies TO demoq_app;

-- TSK-TK-02 / INV-20 and PRJ-GT-05 / INV-06 backstops.
CREATE FUNCTION tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p record;
  missing text[];
BEGIN
  SELECT kind, status INTO p FROM projects WHERE id = NEW.project_id;
  IF p.kind = 'client' THEN
    IF NEW.scope_item_id IS NULL AND NOT NEW.non_deliverable AND NEW.oos_approval_id IS NULL THEN
      RAISE EXCEPTION 'OUT_OF_SCOPE_REQUIRED: task % has no scope item, is not non-deliverable, and has no out-of-scope request', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_scope_link';
    END IF;
    IF NEW.status = 'in_progress' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'in_progress') THEN
      IF NEW.oos_approval_id IS NOT NULL AND NEW.oos_status <> 'approved' THEN
        RAISE EXCEPTION 'OUT_OF_SCOPE_REQUIRED: task % awaits its out-of-scope decision', NEW.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_scope_link';
      END IF;
      SELECT array_agg(g.gate ORDER BY g.gate) INTO missing
      FROM project_gates g
      WHERE g.project_id = NEW.project_id AND g.status = 'missing'
        AND NOT EXISTS (
          SELECT 1 FROM gate_bypasses b
          WHERE b.project_id = NEW.project_id AND b.status = 'open' AND b.expires_at > now() AND g.gate = ANY (b.gates));
      IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'GATE_BLOCKED: missing %', missing USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_gate_blocked';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Change orders (COM-CO-*)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE change_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id),
  scope_id          uuid NOT NULL REFERENCES scopes (id),
  scope_period_id   uuid REFERENCES scope_periods (id),
  number            integer NOT NULL CHECK (number >= 1),
  title             text NOT NULL CHECK (length(btrim(title)) > 0),
  currency          char(3) NOT NULL CHECK (currency IN ('USD', 'KHR')),
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'margin_review', 'ready', 'sent', 'accepted', 'rejected', 'void')),
  fee_price_minor   bigint NOT NULL DEFAULT 0,
  fee_cost_minor    bigint NOT NULL DEFAULT 0,
  pt_price_minor    bigint NOT NULL DEFAULT 0,
  pt_cost_minor     bigint NOT NULL DEFAULT 0,
  discount_minor    bigint NOT NULL DEFAULT 0,
  total_minor       bigint NOT NULL DEFAULT 0,
  fee_margin_bp     integer,
  pt_markup_bp      integer,
  below_floor       boolean NOT NULL DEFAULT false,
  content_sha256    text NOT NULL DEFAULT '',
  submitted_by      uuid REFERENCES users (id),
  submitted_at      timestamptz,
  sent_by           uuid REFERENCES users (id),
  sent_at           timestamptz,
  accepted_by       uuid REFERENCES users (id),
  accepted_at       timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX change_orders_scope_idx ON change_orders (scope_id);
CREATE INDEX change_orders_period_idx ON change_orders (scope_period_id);
CREATE INDEX change_orders_submitted_by_idx ON change_orders (submitted_by);
CREATE INDEX change_orders_sent_by_idx ON change_orders (sent_by);
CREATE INDEX change_orders_accepted_by_idx ON change_orders (accepted_by);

CREATE TABLE change_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id    uuid NOT NULL REFERENCES change_orders (id),
  position           integer NOT NULL CHECK (position >= 0),
  kind               text NOT NULL CHECK (kind IN ('fee', 'pass_through')),
  description_en     text NOT NULL CHECK (length(btrim(description_en)) > 0),
  description_km     text,
  -- COM-CO-01 / INV-05: additive only.
  qty_milli          integer NOT NULL CONSTRAINT change_order_lines_additive_qty CHECK (qty_milli > 0),
  unit_price_minor   bigint NOT NULL CONSTRAINT change_order_lines_additive_price CHECK (unit_price_minor >= 0),
  unit_cost_minor    bigint NOT NULL CHECK (unit_cost_minor >= 0),
  list_price_minor   bigint CHECK (list_price_minor >= 0),
  discount_bp        integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  line_price_minor   bigint NOT NULL CHECK (line_price_minor >= 0),
  line_cost_minor    bigint NOT NULL CHECK (line_cost_minor >= 0),
  quoted_minutes     integer CHECK (quoted_minutes >= 0),
  service_code       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_order_id, position)
);
GRANT DELETE ON change_order_lines TO demoq_app;

CREATE FUNCTION change_orders_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('accepted', 'rejected', 'void')
       OR (OLD.status = 'sent' AND NEW.status NOT IN ('accepted', 'rejected')) THEN
      RAISE EXCEPTION 'QUOTE_LOCKED: change order % → % is not allowed', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
    END IF;
  END IF;
  IF OLD.status IN ('sent', 'accepted', 'rejected', 'void') AND (
       NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.fee_price_minor IS DISTINCT FROM OLD.fee_price_minor OR NEW.pt_price_minor IS DISTINCT FROM OLD.pt_price_minor
    OR NEW.fee_cost_minor IS DISTINCT FROM OLD.fee_cost_minor OR NEW.pt_cost_minor IS DISTINCT FROM OLD.pt_cost_minor
    OR NEW.below_floor IS DISTINCT FROM OLD.below_floor OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.scope_period_id IS DISTINCT FROM OLD.scope_period_id
  ) THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: change order % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  -- COM-CO-02 backstop, as for quotes.
  IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' AND NEW.below_floor AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.kind = 'margin_floor' AND a.subject_type = 'change_order' AND a.subject_id = NEW.id
        AND a.subject_hash = NEW.content_sha256 AND a.status = 'approved' AND a.decided_by <> a.requested_by) THEN
    RAISE EXCEPTION 'MARGIN_BELOW_FLOOR: change order % has no approval for its content', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_floor_backstop';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_orders_lock BEFORE UPDATE ON change_orders FOR EACH ROW EXECUTE FUNCTION change_orders_lock();

CREATE FUNCTION change_order_lines_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM change_orders WHERE id = COALESCE(NEW.change_order_id, OLD.change_order_id);
  IF st NOT IN ('draft', 'margin_review', 'ready') THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: lines of a % change order cannot change', st USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER change_order_lines_lock BEFORE INSERT OR UPDATE OR DELETE ON change_order_lines FOR EACH ROW EXECUTE FUNCTION change_order_lines_lock();

-- ---------------------------------------------------------------------------------------------------------------
-- Giveaway ledger (REP-GV-*): insert-only.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE giveaway_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attributed_month  date NOT NULL CHECK (extract(day FROM attributed_month) = 1),
  occurred_on       date NOT NULL,
  client_id         uuid NOT NULL REFERENCES clients (id),
  project_id        uuid REFERENCES projects (id),
  kind              text NOT NULL CHECK (kind IN ('discount_vs_ratecard', 'absorbed_out_of_scope', 'time_overrun_fixed_fee',
                                                  'bypass_unbilled', 'influencer_extra_unbilled', 'client_credit')),
  amount_usd_minor  bigint NOT NULL,
  fx_rate_micros    bigint NOT NULL CHECK (fx_rate_micros > 0),
  source_type       text NOT NULL,
  source_id         uuid NOT NULL,
  adjusts_entry_id  uuid REFERENCES giveaway_entries (id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX giveaway_entries_month_idx ON giveaway_entries (attributed_month, client_id);
CREATE INDEX giveaway_entries_client_idx ON giveaway_entries (client_id);
CREATE INDEX giveaway_entries_project_idx ON giveaway_entries (project_id);
CREATE INDEX giveaway_entries_adjusts_idx ON giveaway_entries (adjusts_entry_id);
CREATE INDEX giveaway_entries_source_idx ON giveaway_entries (source_type, source_id);
REVOKE UPDATE ON giveaway_entries FROM demoq_app;
CREATE TRIGGER giveaway_entries_insert_only BEFORE UPDATE OR DELETE ON giveaway_entries FOR EACH ROW EXECUTE FUNCTION insert_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers: updated_at + row audit on every business table.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_gate_exemptions', 'scope_periods', 'projects', 'project_gates', 'gate_bypasses',
                           'task_templates', 'task_template_items', 'tasks', 'change_orders', 'change_order_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['client_gate_exemptions', 'scopes', 'scope_periods', 'scope_items', 'projects', 'project_members',
                           'project_gates', 'gate_bypasses', 'task_templates', 'task_template_items', 'tasks',
                           'task_dependencies', 'change_orders', 'change_order_lines', 'giveaway_entries'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Starter templates (D22 / TSK-TP-03). Khmer titles are drafts for the Khmer reviewer.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO task_templates (project_type_id, name)
SELECT id, label_en || ' template' FROM project_types WHERE code IN ('campaign', 'content_production', 'social_management', 'influencer_program');

INSERT INTO task_template_items (template_id, key, position, title_en, title_km, role_hint, offset_days, estimate_minutes, depends_on_keys, client_facing)
SELECT t.id, v.key, v.pos, v.en, v.km, v.role, v.off, v.est, v.deps, v.cf
FROM task_templates t JOIN project_types pt ON pt.id = t.project_type_id
JOIN (VALUES
  ('campaign', 'kickoff', 0, 'Kick-off and brief', 'កិច្ចប្រជុំចាប់ផ្ដើម និងសេចក្ដីសង្ខេប', 'pm', 0, 120, '{}'::text[], false),
  ('campaign', 'concept', 1, 'Creative concept', 'គំនិតច្នៃប្រឌិត', 'creative', 5, 480, '{kickoff}'::text[], true),
  ('campaign', 'assets', 2, 'Produce assets', 'ផលិតឯកសារ', 'designer', 12, 960, '{concept}'::text[], true),
  ('campaign', 'launch', 3, 'Launch and monitor', 'ដាក់ឱ្យដំណើរការ និងតាមដាន', 'pm', 20, 240, '{assets}'::text[], false),
  ('content_production', 'brief', 0, 'Brief and script', 'សេចក្ដីសង្ខេប និងស្គ្រីប', 'copywriter', 0, 240, '{}'::text[], true),
  ('content_production', 'shoot', 1, 'Shoot', 'ថត', 'videographer', 7, 480, '{brief}'::text[], false),
  ('content_production', 'edit', 2, 'Edit', 'កាត់ត', 'editor', 10, 600, '{shoot}'::text[], true),
  ('content_production', 'deliver', 3, 'Deliver final files', 'ប្រគល់ឯកសារចុងក្រោយ', 'pm', 14, 60, '{edit}'::text[], true),
  ('social_management', 'calendar', 0, 'Monthly content calendar', 'ប្រតិទិនមាតិកាប្រចាំខែ', 'social', 0, 240, '{}'::text[], true),
  ('social_management', 'posts', 1, 'Create posts', 'បង្កើតការប្រកាស', 'designer', 5, 900, '{calendar}'::text[], true),
  ('social_management', 'report', 2, 'Monthly report', 'របាយការណ៍ប្រចាំខែ', 'social', 28, 180, '{posts}'::text[], true),
  ('influencer_program', 'shortlist', 0, 'Influencer shortlist', 'បញ្ជីអ្នកមានឥទ្ធិពល', 'influencer_manager', 0, 240, '{}'::text[], true),
  ('influencer_program', 'contracts', 1, 'Contract influencers', 'ចុះកិច្ចសន្យាអ្នកមានឥទ្ធិពល', 'influencer_manager', 5, 240, '{shortlist}'::text[], false),
  ('influencer_program', 'posts', 2, 'Posts go live', 'ការប្រកាសចេញផ្សាយ', 'influencer_manager', 14, 480, '{contracts}'::text[], false),
  ('influencer_program', 'wrap', 3, 'Wrap-up report', 'របាយការណ៍សង្ខេប', 'pm', 28, 180, '{posts}'::text[], true)
) AS v(pt, key, pos, en, km, role, off, est, deps, cf) ON v.pt = pt.code;
