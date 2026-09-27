-- Channels: Telegram linking and single-use action tokens; MCP personal access tokens.
-- Specs: specs/channels/telegram.md (TG-*), specs/channels/mcp.md (MCP-*)

CREATE TABLE telegram_link_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  code_hash   text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id);

-- Opaque button tokens (callback_data "a:<token>"), single use, bound to one Telegram user (TG-04).
CREATE TABLE telegram_actions (
  token            text PRIMARY KEY CHECK (length(token) BETWEEN 8 AND 40),
  approval_id      uuid NOT NULL REFERENCES approvals (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  telegram_user_id bigint NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('approve', 'reject', 'confirm_approve')),
  subject_version  integer NOT NULL,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_actions_approval_idx ON telegram_actions (approval_id);
CREATE INDEX telegram_actions_user_idx ON telegram_actions (user_id);

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  label         text NOT NULL CHECK (length(btrim(label)) > 0),
  token_hash    text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write'] AND cardinality(scopes) > 0),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '30 days')
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TRIGGER telegram_link_codes_audit AFTER INSERT OR UPDATE ON telegram_link_codes FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER telegram_actions_audit AFTER INSERT OR UPDATE ON telegram_actions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER api_tokens_audit AFTER INSERT OR UPDATE ON api_tokens FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Outbox is drained by the worker with SELECT … FOR UPDATE SKIP LOCKED (ADR-0003 revised).
ALTER TABLE outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0, ADD COLUMN last_error text, ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
