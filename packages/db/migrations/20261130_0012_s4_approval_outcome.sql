-- S4 shared: out-of-scope approvals record their outcome (absorb, change_order or reject). APR-EN-13.
-- absorb is the only approving outcome; change_order and reject are rejections with a different follow-up.
ALTER TABLE approvals ADD COLUMN outcome text
  CHECK (outcome IN ('absorb', 'change_order', 'reject'));
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_kind
  CHECK (outcome IS NULL OR (kind = 'out_of_scope' AND status IN ('approved', 'rejected')));
ALTER TABLE approvals ADD CONSTRAINT approvals_outcome_status
  CHECK (outcome IS NULL OR (outcome = 'absorb') = (status = 'approved'));
