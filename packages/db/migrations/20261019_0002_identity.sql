-- Identity and org: users, teams, roles, sessions.
-- Roles are assigned here; what each role may do lives in docs/permission-matrix.signed.csv
-- and packages/core/src/kernel/permissions.ts (CI keeps the two equal).

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  name_km     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    citext NOT NULL UNIQUE,
  display_name             text NOT NULL CHECK (length(btrim(display_name)) > 0),
  display_name_km          text,
  locale                   text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'km')),
  team_id                  uuid REFERENCES teams (id),
  manager_id               uuid REFERENCES users (id),
  password_hash            text NOT NULL,
  totp_secret_enc          text,
  totp_enabled             boolean NOT NULL DEFAULT false,
  totp_last_step           bigint,          -- last accepted TOTP time-step: blocks code replay
  failed_logins            integer NOT NULL DEFAULT 0,
  locked_until             timestamptz,
  telegram_user_id         bigint UNIQUE,
  -- ISO weekday numbers (1 = Monday). DemoQ default Mon–Sat pending decision D15.
  working_days             smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  weekly_capacity_minutes  integer NOT NULL DEFAULT 2880 CHECK (weekly_capacity_minutes >= 0),
  cost_rate_minor          bigint CHECK (cost_rate_minor >= 0),   -- finance.view_costs only (INV-16)
  active                   boolean NOT NULL DEFAULT true,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (manager_id IS NULL OR manager_id <> id),
  CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);
CREATE INDEX users_team_idx ON users (team_id);
CREATE INDEX users_manager_idx ON users (manager_id);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users (id),
  role        text NOT NULL CHECK (role IN (
                'ceo', 'director', 'ops_lead', 'finance', 'account_lead', 'project_manager',
                'team_lead', 'staff', 'influencer_manager', 'admin', 'viewer')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
-- Role removal is a real delete (the audit trigger keeps the history).
GRANT DELETE ON user_roles TO demoq_app;

-- Server-side sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,
  user_id         uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  totp_verified   boolean NOT NULL DEFAULT false,
  ip              inet,
  user_agent      text,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER teams_audit AFTER INSERT OR UPDATE OR DELETE ON teams FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- user_roles has a composite key; row_id is recorded as NULL and the row itself carries user_id.
CREATE TRIGGER user_roles_audit AFTER INSERT OR UPDATE OR DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION audit_row_change();
