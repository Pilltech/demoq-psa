-- Sprint 4: time — attendance, activity codes, allocations, timesheet weeks, holidays, leave.
-- Specs: specs/time/attendance.md (TIM-AT-*), specs/time/timesheets.md (TIM-TS-*), specs/time/leave-holidays.md (TIM-LV-*)
-- Invariants: INV-06 (client-project allocations), INV-11 (attendance), INV-12 (confirmed week locks), INV-18 (leave).
-- Business dates are Asia/Phnom_Penh; a timesheet week runs Monday–Sunday (D-TM-3).

-- Calendar helpers (immutable: used by triggers and indexes).
CREATE FUNCTION business_date(ts timestamptz) RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (ts AT TIME ZONE 'Asia/Phnom_Penh')::date
$$;
CREATE FUNCTION week_start_of(d date) RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT d - (extract(isodow FROM d)::int - 1)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Activity codes (D-TM-1): internal categories for non-client time. Admin-editable (admin.config).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE activity_codes (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_en    text NOT NULL CHECK (length(btrim(label_en)) > 0),
  label_km    text NOT NULL CHECK (length(btrim(label_km)) > 0),
  active      boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO activity_codes (code, label_en, label_km, position) VALUES
  ('admin',            'Administration',         'រដ្ឋបាល',                         10),
  ('internal_meeting', 'Internal meeting',       'កិច្ចប្រជុំផ្ទៃក្នុង',                20),
  ('training',         'Training',               'វគ្គបណ្ដុះបណ្ដាល',                  30),
  ('pitch',            'Pitch / new business',   'ការស្នើគម្រោង / អាជីវកម្មថ្មី',        40),
  ('recruitment',      'Recruitment',            'ការជ្រើសរើសបុគ្គលិក',               50),
  ('leave_admin',      'Leave administration',   'រដ្ឋបាលច្បាប់ឈប់សម្រាក',             60);

-- ---------------------------------------------------------------------------------------------------------------
-- Timesheet weeks (INV-12, D-TM-3, D15). One row per user and ISO week (Monday start).
-- opened_at / first_confirmed_at make the median confirmation time measurable (M2 #10);
-- prefill_minutes and allocation sources make the pre-fill acceptance ratio measurable (M2 #9).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE timesheet_weeks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  week_start          date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed')),
  opened_at           timestamptz,   -- first time the user opened the pre-filled week (web or /week)
  reminded_at         timestamptz,   -- timesheet.remind sent
  escalated_at        timestamptz,   -- timesheet.due_escalate sent to the team lead
  confirmed_at        timestamptz,
  first_confirmed_at  timestamptz,
  confirmed_channel   text CHECK (confirmed_channel IN ('web', 'telegram', 'mcp')),
  draft_hash          text,          -- hash of the draft the user saw when confirming
  prefill_minutes     integer CHECK (prefill_minutes >= 0),  -- pre-filled minutes offered at confirmation
  reopened_at         timestamptz,
  reopened_by         uuid REFERENCES users (id),
  reopen_reason       text,
  reopen_count        integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (first_confirmed_at IS NOT NULL OR confirmed_at IS NULL),
  CONSTRAINT timesheet_weeks_reopen_reason CHECK (reopened_at IS NULL OR length(btrim(reopen_reason)) >= 3),
  CHECK (reopened_by IS NULL OR reopened_by <> user_id)
);
CREATE INDEX timesheet_weeks_week_idx ON timesheet_weeks (week_start, status);
CREATE INDEX timesheet_weeks_reopened_by_idx ON timesheet_weeks (reopened_by);

-- ---------------------------------------------------------------------------------------------------------------
-- Attendance (INV-11, D14): one open session per user; sessions never overlap; no gate check.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE attendance_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id),
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  channel            text NOT NULL CHECK (channel IN ('web', 'telegram', 'mcp', 'job')),
  end_channel        text CHECK (end_channel IN ('web', 'telegram', 'mcp', 'job')),
  auto_closed        boolean NOT NULL DEFAULT false,
  flagged            boolean NOT NULL DEFAULT false,
  flag_reason        text CHECK (flag_reason IN ('auto_closed', 'corrected')),
  correction_reason  text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK (ended_at IS NULL OR ended_at - started_at <= interval '24 hours'),
  CHECK (NOT auto_closed OR (ended_at IS NOT NULL AND flagged)),
  CHECK (flagged = (flag_reason IS NOT NULL)),
  CHECK (flag_reason IS DISTINCT FROM 'corrected' OR (correction_reason IS NOT NULL AND length(btrim(correction_reason)) >= 3)),
  -- TIM-AT-03 / INV-11: sessions of one user never overlap (an open session reaches to infinity).
  CONSTRAINT attendance_sessions_no_overlap
    EXCLUDE USING gist (user_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
);
-- TIM-AT-02 / INV-11: one open session per user.
CREATE UNIQUE INDEX attendance_sessions_one_open ON attendance_sessions (user_id) WHERE ended_at IS NULL;
CREATE INDEX attendance_sessions_user_start_idx ON attendance_sessions (user_id, started_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Allocations (D-TM-1, INV-06). Minutes > 0 per (user, day, target); a day ≤ 24 h. A task target also carries its
-- project so the gate backstop and reports need no join.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE time_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  work_date      date NOT NULL,
  minutes        integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  target_type    text NOT NULL CHECK (target_type IN ('task', 'project', 'deal', 'internal')),
  task_id        uuid REFERENCES tasks (id),
  project_id     uuid REFERENCES projects (id),
  deal_id        uuid REFERENCES deals (id),
  activity_code  text REFERENCES activity_codes (code),
  target_key     text GENERATED ALWAYS AS (COALESCE(task_id::text, project_id::text, deal_id::text, 'code:' || activity_code)) STORED,
  source         text NOT NULL CHECK (source IN ('prefill', 'manual', 'telegram', 'mcp')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  note           text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_allocations_target CHECK (
    (target_type = 'task'     AND task_id IS NOT NULL AND project_id IS NOT NULL AND deal_id IS NULL AND activity_code IS NULL) OR
    (target_type = 'project'  AND task_id IS NULL AND project_id IS NOT NULL AND deal_id IS NULL AND activity_code IS NULL) OR
    (target_type = 'deal'     AND task_id IS NULL AND project_id IS NULL AND deal_id IS NOT NULL AND activity_code IS NULL) OR
    (target_type = 'internal' AND task_id IS NULL AND project_id IS NULL AND deal_id IS NULL AND activity_code IS NOT NULL))
);
CREATE UNIQUE INDEX time_allocations_one_per_target ON time_allocations (user_id, work_date, target_type, target_key);
CREATE INDEX time_allocations_task_idx ON time_allocations (task_id);
CREATE INDEX time_allocations_project_idx ON time_allocations (project_id);
CREATE INDEX time_allocations_deal_idx ON time_allocations (deal_id);
CREATE INDEX time_allocations_code_idx ON time_allocations (activity_code);
-- Drafts are replaced when a week is confirmed; the lock trigger below refuses deletes in a confirmed week.
GRANT DELETE ON time_allocations TO demoq_app;

-- TIM-TS-02 (day ≤ 24 h), TIM-TS-03 / INV-06 (client-project gates), task ↔ project consistency.
CREATE FUNCTION time_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR NEW.minutes IS DISTINCT FROM OLD.minutes OR NEW.work_date IS DISTINCT FROM OLD.work_date) THEN
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
CREATE TRIGGER time_allocations_guard BEFORE INSERT OR UPDATE ON time_allocations
  FOR EACH ROW EXECUTE FUNCTION time_allocations_guard();

-- TIM-TS-06 / INV-12: a confirmed week locks its allocations (any insert, update or delete).
CREATE FUNCTION time_allocations_week_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM timesheet_weeks w WHERE w.user_id = OLD.user_id
        AND w.week_start = week_start_of(OLD.work_date) AND w.status = 'confirmed'))
     OR (TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM timesheet_weeks w WHERE w.user_id = NEW.user_id
        AND w.week_start = week_start_of(NEW.work_date) AND w.status = 'confirmed')) THEN
    RAISE EXCEPTION 'TIMESHEET_CONFIRMED: the week is confirmed and locked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_week_confirmed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER time_allocations_week_lock BEFORE INSERT OR UPDATE OR DELETE ON time_allocations
  FOR EACH ROW EXECUTE FUNCTION time_allocations_week_lock();

-- TIM-TS-06 / INV-12: a confirmed week locks the attendance sessions it confirmed (those started before the
-- confirmation). A session still running at confirmation may only be closed; sessions started afterwards are new
-- attendance and are not locked (see the spec's edge cases).
CREATE FUNCTION attendance_sessions_week_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmed timestamptz;
  closing_only boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT w.confirmed_at INTO confirmed FROM timesheet_weeks w
    WHERE w.user_id = OLD.user_id AND w.week_start = week_start_of(business_date(OLD.started_at)) AND w.status = 'confirmed';
    IF confirmed IS NOT NULL AND OLD.started_at < confirmed THEN
      closing_only := TG_OP = 'UPDATE' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND NEW.started_at = OLD.started_at AND NEW.user_id = OLD.user_id AND NEW.channel = OLD.channel
        AND NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason;
      IF NOT closing_only THEN
        RAISE EXCEPTION 'TIMESHEET_CONFIRMED: session % belongs to a confirmed week', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_week_confirmed';
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT w.confirmed_at INTO confirmed FROM timesheet_weeks w
    WHERE w.user_id = NEW.user_id AND w.week_start = week_start_of(business_date(NEW.started_at)) AND w.status = 'confirmed';
    IF confirmed IS NOT NULL AND NEW.started_at < confirmed
       AND (TG_OP = 'INSERT' OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
      RAISE EXCEPTION 'TIMESHEET_CONFIRMED: % falls in a confirmed week', NEW.started_at
        USING ERRCODE = 'check_violation', CONSTRAINT = 'timesheet_week_confirmed';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER attendance_sessions_week_lock BEFORE INSERT OR UPDATE OR DELETE ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance_sessions_week_lock();

-- ---------------------------------------------------------------------------------------------------------------
-- Holidays (D15, D-HD-1). Everyone reads them; admin manages them (admin.config) and confirms each against the
-- official sub-decree before go-live (verified = false until then).
--
-- Sources for the draft seed (fetched 2026-09-29; official PDFs were not reachable from the build environment):
--   2026: Sub-Decree No. 167 of 18 Sep 2025 on public holidays for 2026 (21 days), transcribed from web-search
--         summaries of Agence Kampuchea Presse (akp.gov.kh/post/detail/347356), the Embassy of Cambodia in Berlin
--         (recberlin.mfaic.gov.kh), Andersen Cambodia and the National Bank of Cambodia holiday page (nbc.gov.kh);
--         none of the pages themselves could be opened. Secondary sources disagree on the Water Festival (23–25 vs
--         24–26 Nov) — the sub-decree summaries give 23–25 Nov.
--   2027: no sub-decree found yet. Fixed-date holidays repeat the 2026 list; lunar holidays (Visak Bochea, Royal
--         Ploughing, Pchum Ben, Water Festival) are ESTIMATES from the lunar calendar and third-party calendars
--         (timeanddate.com, calendarlabs.com). Replace with the 2027 sub-decree when it is published
--         (job holidays.next_year_reminder, plan §4.6).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE holidays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date  date NOT NULL UNIQUE,
  name_en       text NOT NULL CHECK (length(btrim(name_en)) > 0),
  name_km       text NOT NULL CHECK (length(btrim(name_km)) > 0),
  source        text NOT NULL CHECK (length(btrim(source)) > 0),
  verified      boolean NOT NULL DEFAULT false,
  verified_by   uuid REFERENCES users (id),
  verified_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (verified = (verified_at IS NOT NULL))
);
CREATE INDEX holidays_verified_by_idx ON holidays (verified_by);
GRANT DELETE ON holidays TO demoq_app;

INSERT INTO holidays (holiday_date, name_en, name_km, source)
SELECT d::date, en, km, src FROM (VALUES
  -- 2026 — Sub-Decree No. 167 (18 Sep 2025), draft transcription
  ('2026-01-01', 'International New Year''s Day', 'ទិវាចូលឆ្នាំសកល', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-03-08', 'International Women''s Day', 'ទិវាអន្តរជាតិនារី', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-04-14', 'Khmer New Year (day 1)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី១)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-04-15', 'Khmer New Year (day 2)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី២)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-04-16', 'Khmer New Year (day 3)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី៣)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-05-01', 'International Labour Day and Visak Bochea Day', 'ទិវាពលកម្មអន្តរជាតិ និងពិធីបុណ្យវិសាខបូជា', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-05-05', 'Royal Ploughing Ceremony', 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-05-14', 'Birthday of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-06-18', 'Birthday of Her Majesty the Queen Mother', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះវររាជមាតា', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-09-24', 'Constitution Day', 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-10-10', 'Pchum Ben (day 1)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី១)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-10-11', 'Pchum Ben (day 2)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី២)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-10-12', 'Pchum Ben (day 3)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី៣)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-10-15', 'Commemoration Day of the late King Father Norodom Sihanouk', 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះបរមរតនកោដ្ឋ', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-10-29', 'Coronation Day of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-11-09', 'Independence Day', 'ពិធីបុណ្យឯករាជ្យជាតិ', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-11-23', 'Water Festival (day 1)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី១)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-11-24', 'Water Festival (day 2)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី២)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-11-25', 'Water Festival (day 3)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី៣)', 'sub-decree 167/2025 (draft transcription)'),
  ('2026-12-29', 'Peace Day in Cambodia', 'ទិវាសន្តិភាពនៅកម្ពុជា', 'sub-decree 167/2025 (draft transcription)'),
  -- 2027 — no sub-decree yet: fixed dates repeat 2026; lunar dates are estimates
  ('2027-01-01', 'International New Year''s Day', 'ទិវាចូលឆ្នាំសកល', 'estimate (2027 sub-decree pending)'),
  ('2027-01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍', 'estimate (2027 sub-decree pending)'),
  ('2027-03-08', 'International Women''s Day', 'ទិវាអន្តរជាតិនារី', 'estimate (2027 sub-decree pending)'),
  ('2027-04-14', 'Khmer New Year (day 1)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី១)', 'estimate (2027 sub-decree pending)'),
  ('2027-04-15', 'Khmer New Year (day 2)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី២)', 'estimate (2027 sub-decree pending)'),
  ('2027-04-16', 'Khmer New Year (day 3)', 'ពិធីបុណ្យចូលឆ្នាំថ្មី ប្រពៃណីជាតិ (ថ្ងៃទី៣)', 'estimate (2027 sub-decree pending)'),
  ('2027-05-01', 'International Labour Day', 'ទិវាពលកម្មអន្តរជាតិ', 'estimate (2027 sub-decree pending)'),
  ('2027-05-14', 'Birthday of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ', 'estimate (2027 sub-decree pending)'),
  ('2027-05-20', 'Visak Bochea Day', 'ពិធីបុណ្យវិសាខបូជា', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-05-24', 'Royal Ploughing Ceremony', 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-06-18', 'Birthday of Her Majesty the Queen Mother', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះវររាជមាតា', 'estimate (2027 sub-decree pending)'),
  ('2027-09-24', 'Constitution Day', 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ', 'estimate (2027 sub-decree pending)'),
  ('2027-09-29', 'Pchum Ben (day 1)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី១)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-09-30', 'Pchum Ben (day 2)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី២)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-10-01', 'Pchum Ben (day 3)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី៣)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-10-15', 'Commemoration Day of the late King Father Norodom Sihanouk', 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះបរមរតនកោដ្ឋ', 'estimate (2027 sub-decree pending)'),
  ('2027-10-29', 'Coronation Day of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ', 'estimate (2027 sub-decree pending)'),
  ('2027-11-09', 'Independence Day', 'ពិធីបុណ្យឯករាជ្យជាតិ', 'estimate (2027 sub-decree pending)'),
  ('2027-11-12', 'Water Festival (day 1)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី១)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-11-13', 'Water Festival (day 2)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី២)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-11-14', 'Water Festival (day 3)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី៣)', 'estimate, lunar (2027 sub-decree pending)'),
  ('2027-12-29', 'Peace Day in Cambodia', 'ទិវាសន្តិភាពនៅកម្ពុជា', 'estimate (2027 sub-decree pending)')
) AS v (d, en, km, src);

-- ---------------------------------------------------------------------------------------------------------------
-- Leave (D-LV-1, INV-18): seeded types, whole or half days, no balances in v1.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE leave_types (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_en          text NOT NULL,
  label_km          text NOT NULL,
  paid              boolean NOT NULL DEFAULT true,
  half_day_allowed  boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  position          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leave_types (code, label_en, label_km, paid, half_day_allowed, position) VALUES
  ('annual',    'Annual leave',    'ច្បាប់ឈប់សម្រាកប្រចាំឆ្នាំ',        true,  true,  10),
  ('sick',      'Sick leave',      'ច្បាប់ឈប់សម្រាកព្យាបាលជំងឺ',       true,  true,  20),
  ('special',   'Special leave',   'ច្បាប់ឈប់សម្រាកពិសេស',            true,  true,  30),
  ('maternity', 'Maternity leave', 'ច្បាប់ឈប់សម្រាកលំហែមាតុភាព',      true,  false, 40),
  ('unpaid',    'Unpaid leave',    'ច្បាប់ឈប់សម្រាកគ្មានប្រាក់ឈ្នួល',     false, true,  50);

CREATE TABLE leave_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  leave_type    text NOT NULL REFERENCES leave_types (code),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  half_day      text CHECK (half_day IN ('am', 'pm')),
  reason        text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  approval_id   uuid REFERENCES approvals (id),
  decided_by    uuid REFERENCES users (id),
  decided_at    timestamptz,
  cancelled_at  timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date AND end_date - start_date <= 366),
  CHECK (half_day IS NULL OR start_date = end_date),
  CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'requested' OR decided_by IS NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> user_id),
  -- TIM-LV-04: no overlapping requested/approved leave for one person.
  CONSTRAINT leave_requests_no_overlap
    EXCLUDE USING gist (user_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('requested', 'approved'))
);
CREATE INDEX leave_requests_user_idx ON leave_requests (user_id, start_date);
CREATE INDEX leave_requests_approved_idx ON leave_requests (start_date, end_date) WHERE status = 'approved';
CREATE INDEX leave_requests_approval_idx ON leave_requests (approval_id);
CREATE INDEX leave_requests_decided_by_idx ON leave_requests (decided_by);

-- TIM-LV-03: leave is approved only through an approved `leave` approval, decided by someone else.
CREATE FUNCTION leave_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'approved') AND NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.id = NEW.approval_id AND a.kind = 'leave' AND a.subject_type = 'leave_request' AND a.subject_id = NEW.id
        AND a.status = 'approved' AND a.decided_by = NEW.decided_by) THEN
    RAISE EXCEPTION 'FORBIDDEN: leave % has no approved leave approval', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_requests_approved_by_approval';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.start_date IS DISTINCT FROM OLD.start_date
      OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.half_day IS DISTINCT FROM OLD.half_day
      OR NEW.leave_type IS DISTINCT FROM OLD.leave_type) THEN
    RAISE EXCEPTION 'VALIDATION: a leave request''s person, type and dates are fixed; cancel and request again'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_requests_fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leave_requests_guard BEFORE INSERT OR UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION leave_requests_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers: updated_at + row audit on every business table.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activity_codes', 'timesheet_weeks', 'attendance_sessions', 'time_allocations', 'holidays',
                           'leave_types', 'leave_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;
