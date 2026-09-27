-- Hardening after the S2 security review.

-- COM-QB-09: at most one sent quote per deal (backstop for concurrent sends).
CREATE UNIQUE INDEX quotes_one_sent_per_deal ON quotes (deal_id) WHERE status = 'sent';

-- COM-QB-10 / INV-04, tightened: legal status moves only, more frozen columns, and a margin-floor backstop.
CREATE OR REPLACE FUNCTION quotes_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean := OLD.status IN ('sent', 'accepted', 'rejected', 'expired', 'superseded');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('accepted', 'rejected', 'expired', 'superseded')
       OR (OLD.status = 'sent' AND NEW.status NOT IN ('superseded', 'accepted', 'rejected', 'expired')) THEN
      RAISE EXCEPTION 'QUOTE_LOCKED: % → % is not allowed', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
    END IF;
  END IF;
  IF locked AND (
       NEW.currency IS DISTINCT FROM OLD.currency OR NEW.fee_price_minor IS DISTINCT FROM OLD.fee_price_minor
    OR NEW.fee_cost_minor IS DISTINCT FROM OLD.fee_cost_minor OR NEW.pt_price_minor IS DISTINCT FROM OLD.pt_price_minor
    OR NEW.pt_cost_minor IS DISTINCT FROM OLD.pt_cost_minor OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.fx_rate_micros IS DISTINCT FROM OLD.fx_rate_micros OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.terms IS DISTINCT FROM OLD.terms
    OR NEW.billing_model IS DISTINCT FROM OLD.billing_model OR NEW.period_months IS DISTINCT FROM OLD.period_months
    OR NEW.engagement_type_id IS DISTINCT FROM OLD.engagement_type_id OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.sent_by IS DISTINCT FROM OLD.sent_by OR NEW.below_floor IS DISTINCT FROM OLD.below_floor
    OR NEW.fee_margin_bp IS DISTINCT FROM OLD.fee_margin_bp OR NEW.pt_markup_bp IS DISTINCT FROM OLD.pt_markup_bp
  ) THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: quote % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  RETURN NEW;
END $$;

-- COM-QB-06 backstop: a below-floor quote only becomes 'sent' with an approved margin_floor for its exact content,
-- decided by someone other than the requester.
CREATE FUNCTION quotes_floor_backstop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'sent' AND NEW.below_floor AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'sent') THEN
    IF NOT EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.kind = 'margin_floor' AND a.subject_type = 'quote' AND a.subject_id = NEW.id
        AND a.subject_hash = NEW.content_sha256 AND a.status = 'approved' AND a.decided_by <> a.requested_by
    ) THEN
      RAISE EXCEPTION 'MARGIN_BELOW_FLOOR: quote % has no approval for its content', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_floor_backstop';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotes_floor_backstop BEFORE INSERT OR UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_floor_backstop();

-- Audit: also redact Telegram action tokens and link-code hashes.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_j jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  secret text;
BEGIN
  FOREACH secret IN ARRAY ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'code_hash', 'token'] LOOP
    IF old_j ? secret THEN old_j := old_j || jsonb_build_object(secret, '[redacted]'); END IF;
    IF new_j ? secret THEN new_j := new_j || jsonb_build_object(secret, '[redacted]'); END IF;
  END LOOP;
  INSERT INTO audit_changes (table_name, row_id, op, old_row, new_row, actor_id, actor_name, channel, request_id)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(new_j ->> 'id', old_j ->> 'id', new_j ->> 'key', old_j ->> 'key'),
    TG_OP, old_j, new_j,
    NULLIF(current_setting('app.actor_id', true), '')::uuid,
    NULLIF(current_setting('app.actor_name', true), ''),
    NULLIF(current_setting('app.channel', true), ''),
    NULLIF(current_setting('app.request_id', true), '')
  );
  RETURN NULL;
END $$;
