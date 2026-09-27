-- Commercial: engagement types, project types, rate cards, FX, quotes.
-- Specs: specs/commercial/pricing-config.md (COM-CF-*), specs/commercial/quote-builder.md (COM-QB-*)

CREATE TABLE engagement_types (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_en                    text NOT NULL,
  label_km                    text NOT NULL,
  commercial_model            text NOT NULL CHECK (commercial_model IN ('retainer', 'campaign', 'one_off', 'influencer_program')),
  fee_margin_floor_bp         integer NOT NULL DEFAULT 2500 CHECK (fee_margin_floor_bp BETWEEN 0 AND 10000),
  passthrough_markup_floor_bp integer CHECK (passthrough_markup_floor_bp BETWEEN 0 AND 10000),
  passthrough_markup_warn_bp  integer NOT NULL DEFAULT 1000 CHECK (passthrough_markup_warn_bp BETWEEN 0 AND 10000),
  active                      boolean NOT NULL DEFAULT true,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_types (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_en                    text NOT NULL,
  label_km                    text NOT NULL,
  default_engagement_type_id  uuid NOT NULL REFERENCES engagement_types (id),
  active                      boolean NOT NULL DEFAULT true,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_types_engagement_idx ON project_types (default_engagement_type_id);

CREATE TABLE rate_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  currency     char(3) NOT NULL CHECK (currency IN ('USD', 'KHR')),
  active       boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_card_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id      uuid NOT NULL REFERENCES rate_cards (id),
  service_code      text NOT NULL CHECK (service_code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  kind              text NOT NULL CHECK (kind IN ('fee', 'pass_through')),
  label_en          text NOT NULL,
  label_km          text NOT NULL,
  unit              text NOT NULL CHECK (unit IN ('hour', 'day', 'item', 'post', 'month', 'lump')),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
  unit_cost_minor   bigint NOT NULL CHECK (unit_cost_minor >= 0),
  active            boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_card_id, service_code)
);

-- USD→KHR, one row per date. rate_micros = riel per USD × 1,000,000 (exact; no floats).
CREATE TABLE fx_rates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date    date NOT NULL,
  base         char(3) NOT NULL DEFAULT 'USD' CHECK (base = 'USD'),
  quote        char(3) NOT NULL DEFAULT 'KHR' CHECK (quote = 'KHR'),
  rate_micros  bigint NOT NULL CHECK (rate_micros > 0),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'nbc')),
  entered_by   uuid REFERENCES users (id),
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_date, base, quote)
);
CREATE INDEX fx_rates_entered_by_idx ON fx_rates (entered_by);

CREATE TABLE quotes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               uuid NOT NULL REFERENCES deals (id),
  client_id             uuid NOT NULL REFERENCES clients (id),
  owner_id              uuid NOT NULL REFERENCES users (id),
  engagement_type_id    uuid NOT NULL REFERENCES engagement_types (id),
  project_type_id       uuid REFERENCES project_types (id),
  rate_card_id          uuid REFERENCES rate_cards (id),
  version_no            integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  supersedes_quote_id   uuid REFERENCES quotes (id),
  title                 text NOT NULL CHECK (length(btrim(title)) > 0),
  currency              char(3) NOT NULL CHECK (currency IN ('USD', 'KHR')),
  billing_model         text NOT NULL DEFAULT 'one_off' CHECK (billing_model IN ('one_off', 'retainer')),
  period_months         integer CHECK (period_months BETWEEN 1 AND 36),
  valid_until           date,
  terms                 text,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'margin_review', 'ready', 'sent', 'accepted', 'rejected', 'expired', 'superseded')),
  -- Stored results of shared/pricing (COM-QB-02), recomputed by the server on every save.
  fee_price_minor       bigint NOT NULL DEFAULT 0,
  fee_cost_minor        bigint NOT NULL DEFAULT 0,
  pt_price_minor        bigint NOT NULL DEFAULT 0,
  pt_cost_minor         bigint NOT NULL DEFAULT 0,
  discount_minor        bigint NOT NULL DEFAULT 0,
  total_minor           bigint NOT NULL DEFAULT 0,
  fee_margin_bp         integer,
  pt_markup_bp          integer,
  below_floor           boolean NOT NULL DEFAULT false,
  content_sha256        text NOT NULL DEFAULT '',
  send_on_approval      boolean NOT NULL DEFAULT false,
  submitted_by          uuid REFERENCES users (id),
  submitted_at          timestamptz,
  sent_by               uuid REFERENCES users (id),
  sent_at               timestamptz,
  fx_rate_micros        bigint,
  fx_rate_date          date,
  pdf_status            text CHECK (pdf_status IN ('pending', 'ready', 'failed')),
  rejected_reason       text,
  win_reason_code       text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, version_no),
  CHECK ((billing_model = 'retainer') = (period_months IS NOT NULL)),
  -- INV-15: a sent quote always carries its frozen FX rate.
  CHECK (status NOT IN ('sent', 'accepted', 'rejected', 'expired') OR (fx_rate_micros IS NOT NULL AND fx_rate_date IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE UNIQUE INDEX quotes_one_accepted_per_deal ON quotes (deal_id) WHERE status = 'accepted';
CREATE INDEX quotes_client_idx ON quotes (client_id);
CREATE INDEX quotes_owner_idx ON quotes (owner_id);
CREATE INDEX quotes_engagement_idx ON quotes (engagement_type_id);
CREATE INDEX quotes_project_type_idx ON quotes (project_type_id);
CREATE INDEX quotes_rate_card_idx ON quotes (rate_card_id);
CREATE INDEX quotes_supersedes_idx ON quotes (supersedes_quote_id);
CREATE INDEX quotes_status_idx ON quotes (status);
CREATE INDEX quotes_submitted_by_idx ON quotes (submitted_by);
CREATE INDEX quotes_sent_by_idx ON quotes (sent_by);

CREATE TABLE quote_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           uuid NOT NULL REFERENCES quotes (id),
  position           integer NOT NULL CHECK (position >= 0),
  kind               text NOT NULL CHECK (kind IN ('fee', 'pass_through')),
  rate_card_item_id  uuid REFERENCES rate_card_items (id),
  service_code       text,
  description_en     text NOT NULL CHECK (length(btrim(description_en)) > 0),
  description_km     text,
  qty_milli          integer NOT NULL CHECK (qty_milli > 0),
  unit_price_minor   bigint NOT NULL CHECK (unit_price_minor >= 0),
  unit_cost_minor    bigint NOT NULL CHECK (unit_cost_minor >= 0),
  list_price_minor   bigint CHECK (list_price_minor >= 0),
  discount_bp        integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  line_price_minor   bigint NOT NULL CHECK (line_price_minor >= 0),
  line_cost_minor    bigint NOT NULL CHECK (line_cost_minor >= 0),
  per_period         boolean NOT NULL DEFAULT false,
  quoted_minutes     integer CHECK (quoted_minutes >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, position)
);
CREATE INDEX quote_lines_rate_card_item_idx ON quote_lines (rate_card_item_id);
-- Lines of an editable quote are replaced wholesale on save.
GRANT DELETE ON quote_lines TO demoq_app;

-- COM-QB-10 / INV-04: sent quotes are immutable; accepted is terminal.
CREATE FUNCTION quotes_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'accepted' AND NEW.status <> 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: an accepted quote is final' USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  IF OLD.status IN ('sent', 'accepted', 'rejected', 'expired', 'superseded') AND (
       NEW.currency IS DISTINCT FROM OLD.currency OR NEW.fee_price_minor IS DISTINCT FROM OLD.fee_price_minor
    OR NEW.fee_cost_minor IS DISTINCT FROM OLD.fee_cost_minor OR NEW.pt_price_minor IS DISTINCT FROM OLD.pt_price_minor
    OR NEW.pt_cost_minor IS DISTINCT FROM OLD.pt_cost_minor OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.fx_rate_micros IS DISTINCT FROM OLD.fx_rate_micros OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.terms IS DISTINCT FROM OLD.terms
    OR NEW.billing_model IS DISTINCT FROM OLD.billing_model OR NEW.period_months IS DISTINCT FROM OLD.period_months
    OR NEW.engagement_type_id IS DISTINCT FROM OLD.engagement_type_id OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
  ) THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: quote % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotes_lock BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_lock();

CREATE FUNCTION quote_lines_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF st NOT IN ('draft', 'margin_review', 'ready') THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: lines of a % quote cannot change', st USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER quote_lines_lock BEFORE INSERT OR UPDATE OR DELETE ON quote_lines FOR EACH ROW EXECUTE FUNCTION quote_lines_lock();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['engagement_types', 'project_types', 'rate_cards', 'rate_card_items', 'fx_rates', 'quotes', 'quote_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;

-- Starter reference data (D3, D22 defaults). Khmer labels are drafts for the Khmer reviewer.
INSERT INTO engagement_types (code, label_en, label_km, commercial_model, fee_margin_floor_bp, passthrough_markup_floor_bp) VALUES
  ('campaign',           'Campaign',           'យុទ្ធនាការ',               'campaign',           2500, NULL),
  ('retainer',           'Monthly retainer',   'កិច្ចសន្យាប្រចាំខែ',        'retainer',           2500, NULL),
  ('one_off',            'One-off project',    'គម្រោងម្ដង',               'one_off',            2500, NULL),
  ('influencer_program', 'Influencer program', 'កម្មវិធីអ្នកមានឥទ្ធិពល',     'influencer_program', 2500, NULL);
INSERT INTO project_types (code, label_en, label_km, default_engagement_type_id)
SELECT v.code, v.en, v.km, e.id FROM (VALUES
  ('campaign',             'Campaign',                    'យុទ្ធនាការ',                  'campaign'),
  ('content_production',   'Content / video production',  'ផលិតមាតិកា / វីដេអូ',         'one_off'),
  ('social_management',    'Social media management',     'គ្រប់គ្រងបណ្ដាញសង្គម',         'retainer'),
  ('influencer_program',   'Influencer program',          'កម្មវិធីអ្នកមានឥទ្ធិពល',        'influencer_program')
) AS v(code, en, km, et) JOIN engagement_types e ON e.code = v.et;
