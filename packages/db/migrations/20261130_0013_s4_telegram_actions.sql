-- S4 shared: Telegram buttons beyond approve/reject.
--  * out-of-scope cards carry an outcome (Absorb / Change order / Reject, APR-EN-13)
--  * the weekly timesheet card has a one-tap Confirm that is not an approval (kind = timesheet_confirm;
--    payload holds the user's week and the hash of the pre-filled allocations it confirms).
ALTER TABLE telegram_actions ADD COLUMN outcome text CHECK (outcome IN ('absorb', 'change_order', 'reject'));
ALTER TABLE telegram_actions ADD COLUMN kind text NOT NULL DEFAULT 'approval'
  CHECK (kind IN ('approval', 'timesheet_confirm'));
ALTER TABLE telegram_actions ADD COLUMN payload jsonb;
ALTER TABLE telegram_actions ALTER COLUMN approval_id DROP NOT NULL;
ALTER TABLE telegram_actions ADD CONSTRAINT telegram_actions_kind_subject
  CHECK ((kind = 'approval') = (approval_id IS NOT NULL) AND (kind = 'approval' OR payload IS NOT NULL));
ALTER TABLE telegram_actions DROP CONSTRAINT telegram_actions_decision_check;
ALTER TABLE telegram_actions ADD CONSTRAINT telegram_actions_decision_check
  CHECK (decision IN ('approve', 'reject', 'confirm_approve', 'confirm'));
