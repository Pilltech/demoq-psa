-- Hardening after the S1 security review.
-- 1. audit_changes.row_id becomes text, so tables with non-UUID keys can carry the audit trigger (AUD-05).
-- 2. settings gets updated_at + audit triggers (AUD-05).
-- 3. TOTP failures are counted per user (ID-AU-11).

ALTER TABLE audit_changes ALTER COLUMN row_id TYPE text USING row_id::text;

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_j jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  secret text;
BEGIN
  FOREACH secret IN ARRAY ARRAY['password_hash', 'totp_secret_enc', 'token_hash'] LOOP
    IF old_j ? secret THEN old_j := old_j || jsonb_build_object(secret, '[redacted]'); END IF;
    IF new_j ? secret THEN new_j := new_j || jsonb_build_object(secret, '[redacted]'); END IF;
  END LOOP;
  INSERT INTO audit_changes (table_name, row_id, op, old_row, new_row, actor_id, actor_name, channel, request_id)
  VALUES (
    TG_TABLE_NAME,
    -- Any key shape: uuid, bigint or text ids, or a table's natural key column named "key".
    COALESCE(new_j ->> 'id', old_j ->> 'id', new_j ->> 'key', old_j ->> 'key'),
    TG_OP, old_j, new_j,
    NULLIF(current_setting('app.actor_id', true), '')::uuid,
    NULLIF(current_setting('app.actor_name', true), ''),
    NULLIF(current_setting('app.channel', true), ''),
    NULLIF(current_setting('app.request_id', true), '')
  );
  RETURN NULL;
END $$;

CREATE TRIGGER settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER settings_audit AFTER INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE users ADD COLUMN totp_failures integer NOT NULL DEFAULT 0;
