-- Sprint 4 delivery: internal QC, mark sent, client revision rounds, round-4 out-of-scope decisions.
-- Spec: specs/tasks/delivery.md (TSK-DL-*) · Invariants: INV-09, INV-10, INV-20 · Decisions: D1, D2, D-RV-1..3, D-QC-1

-- ---------------------------------------------------------------------------------------------------------------
-- Task states and revision columns
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'internal_review', 'client_ready', 'client_review', 'done', 'cancelled'));

-- Client revision rounds (D-RV-1): 0 until the client first asks for changes.
ALTER TABLE tasks ADD COLUMN revision_round integer NOT NULL DEFAULT 0;
-- The decision on the latest round-4 request (out_of_scope approval with subject_type 'task_revision').
ALTER TABLE tasks ADD COLUMN oos_decision text CHECK (oos_decision IN ('absorb', 'change_order', 'reject'));
ALTER TABLE tasks ADD COLUMN revision_oos_approval_id uuid REFERENCES approvals (id);
-- The latest quality_check requested for this task (its subject_version is the round it covers).
ALTER TABLE tasks ADD COLUMN quality_approval_id uuid REFERENCES approvals (id);
-- What was sent to the client and when (a file version reference until the files module has versions).
ALTER TABLE tasks ADD COLUMN sent_to_client_at timestamptz;
ALTER TABLE tasks ADD COLUMN sent_reference text CHECK (sent_reference IS NULL OR length(btrim(sent_reference)) > 0);
CREATE INDEX tasks_revision_oos_approval_idx ON tasks (revision_oos_approval_id);
CREATE INDEX tasks_quality_approval_idx ON tasks (quality_approval_id);

-- INV-09: round 5 is impossible; round 4 exists only after an "absorb" decision.
ALTER TABLE tasks ADD CONSTRAINT tasks_revision_round_max CHECK (revision_round BETWEEN 0 AND 4);
-- (IS NOT DISTINCT FROM: a NULL decision must fail the check, not pass it as unknown.)
ALTER TABLE tasks ADD CONSTRAINT tasks_revision_round_absorb
  CHECK (revision_round < 4 OR oos_decision IS NOT DISTINCT FROM 'absorb');
-- Only client-facing tasks go to the client.
ALTER TABLE tasks ADD CONSTRAINT tasks_client_states
  CHECK (client_facing OR status NOT IN ('client_ready', 'client_review'));
ALTER TABLE tasks ADD CONSTRAINT tasks_sent_recorded
  CHECK (status <> 'client_review' OR (sent_to_client_at IS NOT NULL AND sent_reference IS NOT NULL));

-- ---------------------------------------------------------------------------------------------------------------
-- Rounds: every QC submission (internal) and every client revision round that started (client). Insert-only.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE task_rounds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id              uuid NOT NULL REFERENCES tasks (id),
  round                integer NOT NULL CHECK (round BETWEEN 0 AND 4),
  kind                 text NOT NULL CHECK (kind IN ('internal', 'client')),
  quality_approval_id  uuid REFERENCES approvals (id),
  oos_approval_id      uuid REFERENCES approvals (id),
  rework_minutes       integer CHECK (rework_minutes > 0),
  note                 text,
  requested_by         uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- An internal round is one QC request; QC loops never count as client rounds (INV-09).
  CHECK ((kind = 'internal') = (quality_approval_id IS NOT NULL)),
  CHECK (kind = 'internal' OR round >= 1),
  -- Round 4 exists only with its out-of-scope decision (INV-09).
  CHECK ((kind = 'client' AND round = 4) = (oos_approval_id IS NOT NULL))
);
CREATE UNIQUE INDEX task_rounds_one_client_round ON task_rounds (task_id, round) WHERE kind = 'client';
CREATE UNIQUE INDEX task_rounds_quality_approval_idx ON task_rounds (quality_approval_id);
CREATE INDEX task_rounds_task_idx ON task_rounds (task_id, round);
CREATE INDEX task_rounds_oos_approval_idx ON task_rounds (oos_approval_id);
CREATE INDEX task_rounds_requested_by_idx ON task_rounds (requested_by);
REVOKE UPDATE ON task_rounds FROM demoq_app;
CREATE TRIGGER task_rounds_insert_only BEFORE UPDATE OR DELETE ON task_rounds FOR EACH ROW EXECUTE FUNCTION insert_only();
CREATE TRIGGER task_rounds_audit AFTER INSERT OR UPDATE OR DELETE ON task_rounds FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ---------------------------------------------------------------------------------------------------------------
-- TSK-TK-02 / PRJ-GT-05: the start backstop now fires when work begins (from todo), not on every move between the
-- delivery states (QC rejection and revision rounds return an already-started task to in_progress).
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.status NOT IN ('todo', 'cancelled') AND (TG_OP = 'INSERT' OR OLD.status IN ('todo', 'cancelled')) THEN
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

-- ---------------------------------------------------------------------------------------------------------------
-- INV-10 / INV-09 backstops for delivery.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION tasks_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- INV-10: nothing reaches the client without an approved QC for the current round, decided by a non-owner.
  IF NEW.status = 'client_review' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'client_review') THEN
    IF NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.kind = 'quality_check' AND a.subject_type = 'task' AND a.subject_id = NEW.id
        AND a.subject_version = NEW.revision_round AND a.status = 'approved'
        AND a.decided_by IS NOT NULL AND a.decided_by <> NEW.owner_id) THEN
      RAISE EXCEPTION 'QC_REQUIRED: task % has no approved quality check for round %', NEW.id, NEW.revision_round
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_qc_required';
    END IF;
  END IF;
  -- INV-09: rounds move one at a time and never go back.
  IF TG_OP = 'INSERT' AND NEW.revision_round <> 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a new task starts at round 0'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_revision_step';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision_round <> OLD.revision_round
     AND (NEW.revision_round <> OLD.revision_round + 1 OR OLD.status <> 'client_review' OR NEW.status <> 'in_progress') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: round % → % (from %)', OLD.revision_round, NEW.revision_round, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_revision_step';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_delivery_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_delivery_guard();
