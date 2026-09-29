-- Sprint 4 hardening (review findings). Specs: specs/tasks/tasks.md, specs/tasks/delivery.md, specs/time/*.md,
-- specs/influencers/links.md. Invariants: INV-06, INV-09, INV-12, INV-13, INV-20.

-- ---------------------------------------------------------------------------------------------------------------
-- INV-20 / D-OS-1 (TSK-TK-02, TSK-TP-02): a non-deliverable task is never client-facing, so an unscoped client
-- deliverable cannot skip the out-of-scope approval. Template tasks created before this rule as both (a client-facing
-- template item with no matching scope item) become internal, as TSK-TP-02 now creates them. A task already in a
-- client state cannot be converted here and makes this migration fail loudly (none exist before go-live).
-- ---------------------------------------------------------------------------------------------------------------
UPDATE tasks SET client_facing = false
WHERE non_deliverable AND client_facing AND status NOT IN ('client_ready', 'client_review');
ALTER TABLE tasks ADD CONSTRAINT tasks_non_deliverable_internal CHECK (NOT (non_deliverable AND client_facing));

-- ---------------------------------------------------------------------------------------------------------------
-- INV-09 (TSK-DL-10): round 4 begins only through its own approved "absorb" decision. Same function as in 0014, plus
-- the round-4 check (a raw UPDATE setting revision_round = 4 and oos_decision = 'absorb' no longer passes).
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tasks_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- INV-09: round 4 needs the task's own round-4 out-of-scope approval, approved with the outcome "absorb".
  IF TG_OP = 'UPDATE' AND NEW.revision_round = 4
     AND (OLD.revision_round <> 4 OR NEW.revision_oos_approval_id IS DISTINCT FROM OLD.revision_oos_approval_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.id = NEW.revision_oos_approval_id AND a.kind = 'out_of_scope' AND a.subject_type = 'task_revision'
        AND a.subject_id = NEW.id AND a.subject_version = 4 AND a.status = 'approved' AND a.outcome = 'absorb') THEN
      RAISE EXCEPTION 'OOS_DECISION_REQUIRED: round 4 of task % needs its approved "absorb" decision', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_revision_oos_approval';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- INV-12 (TIM-TS-06/07): a confirmed week is unlocked only by a recorded reopen. A week is created open; it never
-- moves to another user or week; confirmed → open needs who (not the week's owner), when, why (≥ 3 characters) and
-- reopen_count + 1; the reopen count changes only then.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION timesheet_weeks_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.reopen_count <> 0 THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a timesheet week is created open'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_weeks_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.week_start <> OLD.week_start THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: timesheet week % never changes person or week', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_weeks_transition';
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status = 'open' THEN
    IF NEW.reopened_by IS NULL OR NEW.reopened_by = NEW.user_id OR NEW.reopened_at IS NULL
       OR NEW.reopen_reason IS NULL OR length(btrim(NEW.reopen_reason)) < 3
       OR NEW.reopen_count <> OLD.reopen_count + 1 THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: reopening week % needs who, when, why and the next reopen count', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_weeks_transition';
    END IF;
  ELSIF NEW.reopen_count <> OLD.reopen_count THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: the reopen count of week % changes only on a reopen', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_weeks_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER timesheet_weeks_transition BEFORE INSERT OR UPDATE ON timesheet_weeks
  FOR EACH ROW EXECUTE FUNCTION timesheet_weeks_transition();

-- ---------------------------------------------------------------------------------------------------------------
-- TIM-AT-05/07 (D14): no session is longer than the 12 h cap, and a corrected session ends on the business date it
-- started (the 24 h CHECK from 0015 stays; this one is stricter).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_cap
  CHECK (ended_at IS NULL OR ended_at - started_at <= interval '12 hours');
ALTER TABLE attendance_sessions ADD CONSTRAINT attendance_sessions_corrected_same_day
  CHECK (flag_reason IS DISTINCT FROM 'corrected' OR business_date(ended_at) = business_date(started_at));

-- ---------------------------------------------------------------------------------------------------------------
-- TIM-TS-03 (INV-06): gates guard new or increased time only. Time already stored may be kept, reduced, confirmed or
-- removed after its project becomes gated, held or closed (it was allowed when it was logged).
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION time_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p record;
  day_total integer;
  missing text[];
BEGIN
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'VALIDATION: allocation task % is not in project %', NEW.task_id, NEW.project_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_allocations_target';
  END IF;
  SELECT COALESCE(sum(a.minutes), 0) INTO day_total FROM time_allocations a
  WHERE a.user_id = NEW.user_id AND a.work_date = NEW.work_date AND a.id <> NEW.id;
  IF day_total + NEW.minutes > 1440 THEN
    RAISE EXCEPTION 'VALIDATION: allocations on % exceed 24 h', NEW.work_date
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_allocations_day_cap';
  END IF;
  IF NEW.project_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.work_date IS DISTINCT FROM OLD.work_date
      OR NEW.minutes > OLD.minutes) THEN
    SELECT kind INTO p FROM projects WHERE id = NEW.project_id;
    IF p.kind = 'client' THEN
      SELECT array_agg(g.gate ORDER BY g.gate) INTO missing
      FROM project_gates g
      WHERE g.project_id = NEW.project_id AND g.status = 'missing'
        AND NOT EXISTS (
          SELECT 1 FROM gate_bypasses b
          WHERE b.project_id = NEW.project_id AND b.status = 'open' AND b.expires_at > now() AND g.gate = ANY (b.gates));
      IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'GATE_BLOCKED: missing %', missing
          USING ERRCODE = 'check_violation', CONSTRAINT = 'time_allocations_gate_blocked';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- INF-LK-02/07/09: the link and submission backstops judge a row at its own `issued_at` / `submitted_at`. Those times
-- come from the command clock, so they must agree with the database clock: a row further from now() than
-- `max_skew_seconds` is refused (a backdated submission cannot slip in before a link's expiry or a bypass's end).
-- `app_clock_policy` is owned by the migrator; the app role may only read it. Production keeps 5 minutes. The test
-- template (packages/testkit/src/db.ts) widens it, because the suite runs on a fake clock set weeks away from now().
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE app_clock_policy (
  singleton         boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_skew_seconds  integer NOT NULL DEFAULT 300 CHECK (max_skew_seconds >= 0),
  note              text
);
INSERT INTO app_clock_policy DEFAULT VALUES;
REVOKE INSERT, UPDATE, DELETE ON app_clock_policy FROM demoq_app;
GRANT SELECT ON app_clock_policy TO demoq_app;

CREATE FUNCTION app_clock_ok(ts timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT abs(extract(epoch FROM ts - now())) <= p.max_skew_seconds FROM app_clock_policy p), false)
$$;

CREATE FUNCTION work_log_links_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_clock_ok(NEW.issued_at) THEN
    RAISE EXCEPTION 'VALIDATION: issued_at % is not the current time', NEW.issued_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'work_log_links_clock';
  END IF;
  RETURN NEW;
END $$;
-- Fires before work_log_links_guard (triggers of one event run in name order).
CREATE TRIGGER work_log_links_clock BEFORE INSERT ON work_log_links FOR EACH ROW EXECUTE FUNCTION work_log_links_clock();

CREATE FUNCTION influencer_work_logs_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_clock_ok(NEW.submitted_at) THEN
    RAISE EXCEPTION 'VALIDATION: submitted_at % is not the current time', NEW.submitted_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'influencer_work_logs_clock';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER influencer_work_logs_clock BEFORE INSERT ON influencer_work_logs
  FOR EACH ROW EXECUTE FUNCTION influencer_work_logs_clock();

-- ---------------------------------------------------------------------------------------------------------------
-- INF-LK-12 / INV-13: the value of an absorbed extra post is written once, and only when the post is approved and
-- its out-of-scope outcome is "absorb" (whichever decision comes second). Correcting rows (adjusts_entry_id) are free.
-- ---------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX giveaway_entries_one_extra_post ON giveaway_entries (source_id)
  WHERE kind = 'influencer_extra_unbilled' AND adjusts_entry_id IS NULL;

CREATE FUNCTION giveaway_entries_extra_post_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'influencer_extra_unbilled' AND NEW.adjusts_entry_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM influencer_work_logs l
      WHERE l.id = NEW.source_id AND l.status = 'approved' AND l.over_quantity AND l.oos_outcome = 'absorb') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: extra post % is not both approved and absorbed', NEW.source_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'giveaway_entries_extra_post_approved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER giveaway_entries_extra_post_guard BEFORE INSERT ON giveaway_entries
  FOR EACH ROW EXECUTE FUNCTION giveaway_entries_extra_post_guard();
