-- Sprint 3 hardening, from the independent review of the S3 backend.

-- PRJ-BP-05: one bypass review per month, even with two workers.
CREATE UNIQUE INDEX approvals_one_bypass_review_per_month ON approvals (subject_hash)
  WHERE kind = 'bypass_review' AND status IN ('pending', 'approved', 'rejected');

-- PRJ-GT-05 / TSK-TK-02: the backstop covers every way into work (in_progress or done), not only in_progress.
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
    IF NEW.status IN ('in_progress', 'done') AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('in_progress', 'done')) THEN
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

-- PRJ-BP-06: created_at cannot move (the expiry CHECK is relative to it), expiry cannot be extended, and a bypass
-- opens only with an approved gate_bypass approval decided by its approver.
CREATE FUNCTION gate_bypasses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at > OLD.expires_at
       OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.gates IS DISTINCT FROM OLD.gates
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
      RAISE EXCEPTION 'BYPASS_INVALID: a bypass''s project, gates, requester, creation and expiry are fixed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'gate_bypasses_expiry';
    END IF;
  END IF;
  IF NEW.status = 'open' AND (TG_OP = 'INSERT' OR OLD.status <> 'open') AND NOT NEW.legacy AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.id = NEW.approval_id AND a.kind = 'gate_bypass' AND a.subject_type = 'gate_bypass' AND a.subject_id = NEW.id
        AND a.status = 'approved' AND a.decided_by = NEW.approved_by) THEN
    RAISE EXCEPTION 'BYPASS_INVALID: bypass % has no approved gate_bypass approval', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gate_bypasses_approved_by_human';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gate_bypasses_guard BEFORE INSERT OR UPDATE ON gate_bypasses FOR EACH ROW EXECUTE FUNCTION gate_bypasses_guard();

-- COM-CO-02/03: accepted and rejected only from sent; the floor backstop also covers acceptance.
CREATE OR REPLACE FUNCTION change_orders_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('accepted', 'rejected', 'void')
       OR (OLD.status = 'sent' AND NEW.status NOT IN ('accepted', 'rejected'))
       OR (NEW.status IN ('accepted', 'rejected') AND OLD.status <> 'sent')
       OR (NEW.status = 'sent' AND OLD.status <> 'ready') THEN
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
  IF NEW.status IN ('sent', 'accepted') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.below_floor AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.kind = 'margin_floor' AND a.subject_type = 'change_order' AND a.subject_id = NEW.id
        AND a.subject_hash = NEW.content_sha256 AND a.status = 'approved' AND a.decided_by <> a.requested_by) THEN
    RAISE EXCEPTION 'MARGIN_BELOW_FLOOR: change order % has no approval for its content', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_floor_backstop';
  END IF;
  RETURN NEW;
END $$;
