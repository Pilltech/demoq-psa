-- CRM: clients, contacts, close reasons, deals (pipeline).
-- Spec: specs/crm/clients.md, specs/crm/close-reason.md

CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  name_km          text,
  account_lead_id  uuid NOT NULL REFERENCES users (id),
  team_id          uuid REFERENCES teams (id),
  industry         text,
  -- INV-21: PO gate is required unless Finance/Ops records an exemption (from S3).
  po_required      boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  airtable_id      text UNIQUE,
  legacy           boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_account_lead_idx ON clients (account_lead_id);
CREATE INDEX clients_team_idx ON clients (team_id);
CREATE INDEX clients_name_trgm_idx ON clients USING gin (name gin_trgm_ops);
CREATE INDEX clients_name_km_trgm_idx ON clients USING gin (name_km gin_trgm_ops);

CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients (id),
  full_name    text NOT NULL CHECK (length(btrim(full_name)) > 0),
  title        text,
  email        citext,
  phone        text,
  telegram     text,
  is_primary   boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  airtable_id  text UNIQUE,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_client_idx ON contacts (client_id);
-- At most one primary contact per client.
CREATE UNIQUE INDEX contacts_one_primary_idx ON contacts (client_id) WHERE is_primary AND archived_at IS NULL;

-- Admin-editable. kind says which outcome the reason explains.
CREATE TABLE close_reasons (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  kind         text NOT NULL CHECK (kind IN ('won', 'lost')),
  label_en     text NOT NULL,
  label_km     text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  legacy_only  boolean NOT NULL DEFAULT false,   -- e.g. legacy_unrecorded, import only
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, kind)
);

CREATE TABLE deals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES clients (id),
  title              text NOT NULL CHECK (length(btrim(title)) > 0),
  owner_id           uuid NOT NULL REFERENCES users (id),     -- the account lead
  stage              text NOT NULL DEFAULT 'lead'
                       CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  expected_value_minor bigint CHECK (expected_value_minor >= 0),
  currency           char(3) NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'KHR')),
  expected_close_on  date,
  close_reason_code  text,
  close_reason_kind  text,
  close_note         text,
  closed_at          timestamptz,
  airtable_id        text UNIQUE,
  legacy             boolean NOT NULL DEFAULT false,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The reason must exist and be of the right kind.
  FOREIGN KEY (close_reason_code, close_reason_kind) REFERENCES close_reasons (code, kind),
  -- INV-01 backstop: Won/Lost ⇔ a reason of the matching kind; open deals carry no reason.
  CONSTRAINT deals_close_reason_required CHECK (
    (stage IN ('won', 'lost') AND close_reason_code IS NOT NULL AND close_reason_kind = stage AND closed_at IS NOT NULL)
    OR
    (stage NOT IN ('won', 'lost') AND close_reason_code IS NULL AND close_reason_kind IS NULL AND closed_at IS NULL)
  )
);
CREATE INDEX deals_client_idx ON deals (client_id);
CREATE INDEX deals_owner_idx ON deals (owner_id);
CREATE INDEX deals_stage_idx ON deals (stage);
CREATE INDEX deals_close_reason_idx ON deals (close_reason_code, close_reason_kind);

CREATE TABLE deal_stage_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- stable order within one instant
  deal_id            uuid NOT NULL REFERENCES deals (id),
  from_stage         text,
  to_stage           text NOT NULL,
  close_reason_code  text,
  note               text,
  changed_by         uuid REFERENCES users (id),
  changed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deal_stage_history_deal_idx ON deal_stage_history (deal_id, seq);
CREATE INDEX deal_stage_history_changed_by_idx ON deal_stage_history (changed_by);
REVOKE UPDATE ON deal_stage_history FROM demoq_app;   -- history is insert-only

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER close_reasons_updated_at BEFORE UPDATE ON close_reasons FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER deals_updated_at BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER clients_audit AFTER INSERT OR UPDATE OR DELETE ON clients FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER contacts_audit AFTER INSERT OR UPDATE OR DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER close_reasons_audit AFTER INSERT OR UPDATE OR DELETE ON close_reasons FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER deals_audit AFTER INSERT OR UPDATE OR DELETE ON deals FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER deal_stage_history_audit AFTER INSERT ON deal_stage_history FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Reference data (admin-editable later). Khmer labels are drafts pending the Khmer reviewer (KM-DRAFT).
INSERT INTO close_reasons (code, kind, label_en, label_km, sort_order) VALUES
  ('price',            'lost', 'Price too high',              'តម្លៃខ្ពស់ពេក', 10),
  ('competitor',       'lost', 'Chose a competitor',          'ជ្រើសរើសដៃគូប្រកួតប្រជែង', 20),
  ('budget_cut',       'lost', 'Client budget cut',           'អតិថិជនកាត់ថវិកា', 30),
  ('timing',           'lost', 'Timing not right',            'ពេលវេលាមិនត្រូវ', 40),
  ('no_response',      'lost', 'Client stopped responding',   'អតិថិជនឈប់ឆ្លើយតប', 50),
  ('scope_mismatch',   'lost', 'Scope not a fit for DemoQ',   'វិសាលភាពមិនសមនឹង DemoQ', 60),
  ('relationship',     'won',  'Existing relationship',       'ទំនាក់ទំនងស្រាប់', 10),
  ('creative',         'won',  'Creative idea won',           'គំនិតច្នៃប្រឌិតឈ្នះ', 20),
  ('price_value',      'won',  'Best value',                  'តម្លៃសមរម្យបំផុត', 30),
  ('influencer_reach', 'won',  'Influencer network',          'បណ្ដាញអ្នកមានឥទ្ធិពល', 40);
INSERT INTO close_reasons (code, kind, label_en, label_km, legacy_only, active, sort_order) VALUES
  ('legacy_unrecorded',     'lost', 'Not recorded (imported from Airtable)', 'មិនបានកត់ត្រា (នាំចូលពី Airtable)', true, true, 999),
  ('legacy_won_unrecorded', 'won',  'Not recorded (imported from Airtable)', 'មិនបានកត់ត្រា (នាំចូលពី Airtable)', true, true, 999);
