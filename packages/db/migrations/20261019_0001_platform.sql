-- Platform foundation: grants model, append-only audit, outbox, settings.
-- Runs as demoq_migrator (schema owner). The app connects as demoq_app.
-- Extensions (pgcrypto, citext, pg_trgm, btree_gist) are created by scripts/db-setup.sh.

-- Every table the migrator creates is readable/writable by the app, but never deletable.
-- Audit tables get their UPDATE revoked explicitly below (INV-14).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO demoq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO demoq_app;
GRANT USAGE ON SCHEMA public TO demoq_app;

-- Shared trigger: keep updated_at honest.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Semantic audit: one row per command (or MCP read), written by executeCommand
-- in the same transaction as the change. Names the actor (INV-14).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL,                 -- command/query name, e.g. 'deal.close_lost'
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'job', 'influencer_link', 'anonymous')),
  actor_id      uuid,
  actor_name    text NOT NULL,                 -- denormalised on purpose: the name at the time
  channel       text NOT NULL CHECK (channel IN ('web', 'telegram', 'mcp', 'job', 'link')),
  subject_type  text,
  subject_id    uuid,
  request_id    text NOT NULL,
  on_behalf_of  uuid,                          -- approval id when a job acts for a requester
  mcp_client    text,
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- redacted input
  outcome       text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'denied')),
  error_code    text
);
CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at DESC);

-- Row-level change capture for every business table (belt and braces for INV-14).
CREATE TABLE audit_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  table_name  text NOT NULL,
  row_id      uuid,
  op          text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  old_row     jsonb,
  new_row     jsonb,
  actor_id    uuid,
  actor_name  text,
  channel     text,
  request_id  text
);
CREATE INDEX audit_changes_row_idx ON audit_changes (table_name, row_id, changed_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, audit_changes FROM demoq_app;
GRANT SELECT, INSERT ON audit_events, audit_changes TO demoq_app;

CREATE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();
CREATE TRIGGER audit_changes_append_only BEFORE UPDATE OR DELETE ON audit_changes
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();
CREATE TRIGGER audit_changes_no_truncate BEFORE TRUNCATE ON audit_changes
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();

-- Attach with: CREATE TRIGGER <t>_audit AFTER INSERT OR UPDATE OR DELETE ON <t>
--   FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- Actor context comes from set_config('app.*', ..., true) in executeCommand.
-- Columns listed in app.redact_columns are masked (secrets never land in audit).
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
    COALESCE((new_j ->> 'id'), (old_j ->> 'id'))::uuid,
    TG_OP, old_j, new_j,
    NULLIF(current_setting('app.actor_id', true), '')::uuid,
    NULLIF(current_setting('app.actor_name', true), ''),
    NULLIF(current_setting('app.channel', true), ''),
    NULLIF(current_setting('app.request_id', true), '')
  );
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Transactional outbox: domain events written in the command transaction,
-- delivered by the worker (pg-boss from S2).
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  request_id    text NOT NULL,
  delivered_at  timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE delivered_at IS NULL;

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
