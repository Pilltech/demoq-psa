-- Sprint 4 (S4-07): influencer roster, assignments, expiring work-log links and submissions.
-- Spec: specs/influencers/links.md (INF-RS-*, INF-LK-*). Decisions: D13, D-IN-1, D-IN-2. Invariants: INV-06, INV-13.
-- The influencer never has an account: a link token (256-bit, only its SHA-256 stored) reaches one assignment.

-- ---------------------------------------------------------------------------------------------------------------
-- Roster (INF-RS-01)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE influencers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  -- [{"platform": "tiktok", "handle": "@name"}, …]
  handles       jsonb NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(handles) = 'array' AND jsonb_array_length(handles) <= 10),
  phone         text CHECK (length(phone) <= 40),
  telegram      text CHECK (length(telegram) <= 100),
  notes         text CHECK (length(notes) <= 2000),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX influencers_name_idx ON influencers (lower(display_name));

-- ---------------------------------------------------------------------------------------------------------------
-- Assignments (INF-RS-02, INF-RS-03): one influencer on one deliverable (scope item) of a project.
-- The per-post pass-through is in the project's scope currency (D-IN-2 valuation at the scope's frozen rate).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE influencer_assignments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES projects (id),
  scope_item_id               uuid NOT NULL REFERENCES scope_items (id),
  influencer_id               uuid NOT NULL REFERENCES influencers (id),
  contracted_posts            integer NOT NULL CHECK (contracted_posts BETWEEN 1 AND 1000),
  per_post_passthrough_minor  bigint CHECK (per_post_passthrough_minor >= 0),
  currency                    char(3) CHECK (currency IN ('USD', 'KHR')),
  notes                       text CHECK (length(notes) <= 2000),
  active                      boolean NOT NULL DEFAULT true,
  created_by                  uuid NOT NULL REFERENCES users (id),
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scope_item_id, influencer_id),
  CHECK ((per_post_passthrough_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX influencer_assignments_scope_item_idx ON influencer_assignments (scope_item_id);
CREATE INDEX influencer_assignments_influencer_idx ON influencer_assignments (influencer_id);
CREATE INDEX influencer_assignments_created_by_idx ON influencer_assignments (created_by);

-- INF-RS-03 backstop: the scope item belongs to the project's scope; the three keys never change.
CREATE FUNCTION influencer_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.project_id <> OLD.project_id OR NEW.scope_item_id <> OLD.scope_item_id
                           OR NEW.influencer_id <> OLD.influencer_id) THEN
    RAISE EXCEPTION 'VALIDATION: the project, deliverable and influencer of an assignment never change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_assignments_scope_item';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM projects p JOIN scope_items s ON s.scope_id = p.scope_id
      WHERE p.id = NEW.project_id AND s.id = NEW.scope_item_id) THEN
    RAISE EXCEPTION 'VALIDATION: scope item % is not part of project %', NEW.scope_item_id, NEW.project_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_assignments_scope_item';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER influencer_assignments_guard BEFORE INSERT OR UPDATE ON influencer_assignments
  FOR EACH ROW EXECUTE FUNCTION influencer_assignments_guard();

-- INV-06 in SQL: the gates of a client project still missing at `p_at` after open, unexpired bypasses.
-- `p_at` is the row's own business time (issued_at / submitted_at, set from the command clock).
CREATE FUNCTION inf_uncovered_gates(p_project uuid, p_at timestamptz) RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT array_agg(g.gate ORDER BY g.gate)
  FROM project_gates g JOIN projects p ON p.id = g.project_id
  WHERE g.project_id = p_project AND p.kind = 'client' AND g.status = 'missing'
    AND NOT EXISTS (
      SELECT 1 FROM gate_bypasses b
      WHERE b.project_id = p_project AND b.status = 'open' AND b.expires_at > p_at AND g.gate = ANY (b.gates));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Work-log links (INF-LK-01…05, D13)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE work_log_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id    uuid NOT NULL REFERENCES influencer_assignments (id),
  -- SHA-256 (hex) of the 256-bit token. The token itself is never stored.
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'exhausted')),
  issued_by        uuid NOT NULL REFERENCES users (id),
  issued_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  max_submissions  integer NOT NULL DEFAULT 10 CHECK (max_submissions BETWEEN 1 AND 50),
  revoked_by       uuid REFERENCES users (id),
  revoked_at       timestamptz,
  revoke_reason    text CHECK (length(revoke_reason) <= 500),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_log_links_expiry CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 days'),
  CONSTRAINT work_log_links_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX work_log_links_assignment_idx ON work_log_links (assignment_id);
CREATE INDEX work_log_links_issued_by_idx ON work_log_links (issued_by);
CREATE INDEX work_log_links_revoked_by_idx ON work_log_links (revoked_by);
CREATE INDEX work_log_links_due_idx ON work_log_links (expires_at) WHERE status = 'active';

-- INF-LK-02 / INV-06 backstop on issue; INF-LK-04: a dead link stays dead and its terms never change.
CREATE FUNCTION work_log_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  missing text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a link is issued active' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_log_links_terminal';
    END IF;
    missing := inf_uncovered_gates((SELECT project_id FROM influencer_assignments WHERE id = NEW.assignment_id), NEW.issued_at);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'GATE_BLOCKED: missing %', missing USING ERRCODE = 'check_violation', CONSTRAINT = 'work_log_links_gate_blocked';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.token_hash <> OLD.token_hash OR NEW.assignment_id <> OLD.assignment_id OR NEW.issued_at <> OLD.issued_at
     OR NEW.issued_by <> OLD.issued_by OR NEW.expires_at <> OLD.expires_at OR NEW.max_submissions <> OLD.max_submissions THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: link terms never change' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_log_links_terminal';
  END IF;
  IF OLD.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: link % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'work_log_links_terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_log_links_guard BEFORE INSERT OR UPDATE ON work_log_links FOR EACH ROW EXECUTE FUNCTION work_log_links_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Submissions (INF-LK-06…12). Proof is the post URL plus up to 5 proof links until R2 lands (D-IN-1).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION inf_http_urls(urls text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(bool_and(u ~ '^https?://[^[:space:]]+$' AND length(u) <= 2000), true) FROM unnest(urls) AS u;
$$;

CREATE TABLE influencer_work_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id    uuid NOT NULL REFERENCES influencer_assignments (id),
  link_id          uuid NOT NULL REFERENCES work_log_links (id),
  post_url         text NOT NULL CHECK (post_url ~ '^https?://[^[:space:]]+$' AND length(post_url) <= 2000),
  posted_on        date NOT NULL,
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  proof_urls       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(proof_urls) <= 5 AND inf_http_urls(proof_urls)),
  note             text CHECK (length(note) <= 1000),
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  over_quantity    boolean NOT NULL DEFAULT false,
  approval_id      uuid REFERENCES approvals (id),
  oos_approval_id  uuid REFERENCES approvals (id),
  oos_outcome      text CHECK (oos_outcome IN ('absorb', 'change_order', 'reject')),
  ip               inet,
  user_agent       text CHECK (length(user_agent) <= 400),
  submitted_at     timestamptz NOT NULL,
  decided_by       uuid REFERENCES users (id),
  decided_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT influencer_work_logs_decided CHECK ((status = 'submitted') = (decided_by IS NULL AND decided_at IS NULL)),
  CONSTRAINT influencer_work_logs_oos CHECK (over_quantity OR (oos_approval_id IS NULL AND oos_outcome IS NULL))
);
CREATE INDEX influencer_work_logs_assignment_idx ON influencer_work_logs (assignment_id, status);
CREATE INDEX influencer_work_logs_link_idx ON influencer_work_logs (link_id);
CREATE INDEX influencer_work_logs_approval_idx ON influencer_work_logs (approval_id);
CREATE INDEX influencer_work_logs_oos_approval_idx ON influencer_work_logs (oos_approval_id);
CREATE INDEX influencer_work_logs_decided_by_idx ON influencer_work_logs (decided_by);
-- INF-LK-08: the same post counts once per assignment (a rejected one may be sent again).
CREATE UNIQUE INDEX influencer_work_logs_one_post ON influencer_work_logs (assignment_id, post_url) WHERE status <> 'rejected';

-- Backstops: a submission goes through a live link of its own assignment, within the cap, on an ungated project
-- (INF-LK-03/05/07, INV-06); content is immutable; approved only through an approved influencer_work approval (INV-13).
CREATE FUNCTION influencer_work_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l record;
  used integer;
  missing text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO l FROM work_log_links WHERE id = NEW.link_id FOR UPDATE;
    IF l.assignment_id IS DISTINCT FROM NEW.assignment_id THEN
      RAISE EXCEPTION 'NOT_FOUND: link % does not reach assignment %', NEW.link_id, NEW.assignment_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_own_assignment';
    END IF;
    SELECT count(*) INTO used FROM influencer_work_logs WHERE link_id = NEW.link_id;
    IF l.status <> 'active' OR l.expires_at <= NEW.submitted_at OR used >= l.max_submissions THEN
      RAISE EXCEPTION 'LINK_EXPIRED: link % is % (% of % used)', l.id, l.status, used, l.max_submissions
        USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_link_inactive';
    END IF;
    missing := inf_uncovered_gates((SELECT project_id FROM influencer_assignments WHERE id = NEW.assignment_id), NEW.submitted_at);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'GATE_BLOCKED: missing %', missing USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_gate_blocked';
    END IF;
    IF NEW.status <> 'submitted' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a submission starts as submitted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_approval_required';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assignment_id <> OLD.assignment_id OR NEW.link_id <> OLD.link_id OR NEW.post_url <> OLD.post_url
     OR NEW.posted_on <> OLD.posted_on OR NEW.metrics <> OLD.metrics OR NEW.proof_urls <> OLD.proof_urls
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.submitted_at <> OLD.submitted_at OR NEW.over_quantity <> OLD.over_quantity
     OR NEW.ip IS DISTINCT FROM OLD.ip OR NEW.user_agent IS DISTINCT FROM OLD.user_agent THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a submission never changes after it is sent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'submitted' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: submission % is already %', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_immutable';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM approvals a
        WHERE a.id = NEW.approval_id AND a.kind = 'influencer_work' AND a.subject_id = NEW.id
          AND a.status = NEW.status AND a.decided_by = NEW.decided_by) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: submission % needs its influencer_work approval', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_approval_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER influencer_work_logs_guard BEFORE INSERT OR UPDATE ON influencer_work_logs
  FOR EACH ROW EXECUTE FUNCTION influencer_work_logs_guard();

-- INV-13: reports and counts read approved work only, through this view.
CREATE VIEW v_influencer_work_approved AS
SELECT l.id, l.assignment_id, a.project_id, a.scope_item_id, a.influencer_id, l.post_url, l.posted_on, l.metrics,
       l.over_quantity, l.oos_outcome, l.decided_by AS approved_by, l.decided_at AS approved_at
FROM influencer_work_logs l
JOIN influencer_assignments a ON a.id = l.assignment_id
WHERE l.status = 'approved';

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers: updated_at + row audit on every business table (token_hash is redacted by audit_row_change).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['influencers', 'influencer_assignments', 'work_log_links', 'influencer_work_logs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;
