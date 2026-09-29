-- S4-08 MCP OAuth: authorization-server storage, OAuth clients, MCP confirm tokens, the mcp.writes flag,
-- the OAuth grant on audit rows and the INV-19 backstop. Spec: specs/channels/mcp-oauth.md (MCP-OA-*)

-- oidc-provider storage adapter (plan §4.2). Protocol state, not business data: rows expire and are
-- deleted by the provider (destroy / revokeByGrantId), so the app role may DELETE here and nowhere else.
-- Token-like ids (access/refresh tokens, codes) are stored as SHA-256 and their jti is not kept in the
-- payload, so a database read never yields a usable token.
CREATE TABLE oidc_payloads (
  model        text NOT NULL CHECK (model IN (
                 'Session', 'AccessToken', 'AuthorizationCode', 'RefreshToken', 'ClientCredentials', 'Interaction',
                 'ReplayDetection', 'PushedAuthorizationRequest', 'Grant', 'DeviceCode', 'BackchannelAuthenticationRequest')),
  id           text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  payload      jsonb NOT NULL,
  grant_id     text,
  uid          text,
  -- Grants only: who consented to which client (remembered consent, D-MC-2).
  account_id   uuid REFERENCES users (id),
  client_id    text,
  expires_at   timestamptz,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, id)
);
CREATE INDEX oidc_payloads_grant_idx ON oidc_payloads (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX oidc_payloads_uid_idx ON oidc_payloads (model, uid) WHERE uid IS NOT NULL;
CREATE INDEX oidc_payloads_consent_idx ON oidc_payloads (account_id, client_id, expires_at DESC) WHERE model = 'Grant';
CREATE INDEX oidc_payloads_expiry_idx ON oidc_payloads (expires_at);
GRANT DELETE ON oidc_payloads TO demoq_app;

-- OAuth clients (D-MC-1): the one pre-registered Cowork client (from configuration) and cached Client ID
-- Metadata Documents (Claude Code; cached 24 h). Dynamic registration is off, so nothing else lands here.
CREATE TABLE oauth_clients (
  client_id    text PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND 2048),
  kind         text NOT NULL CHECK (kind IN ('preregistered', 'cimd')),
  metadata     jsonb NOT NULL,
  -- CIMD cache: when the document was fetched and when it must be fetched again.
  fetched_at   timestamptz,
  expires_at   timestamptz,
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_cimd_cache CHECK ((kind = 'cimd') = (expires_at IS NOT NULL AND fetched_at IS NOT NULL)),
  CONSTRAINT oauth_clients_cimd_ttl CHECK (kind <> 'cimd' OR expires_at <= fetched_at + interval '24 hours'),
  -- A public client: never a shared secret (MCP-OA-04).
  CONSTRAINT oauth_clients_public CHECK (NOT (metadata ? 'client_secret') AND metadata ->> 'token_endpoint_auth_method' = 'none')
);
CREATE TRIGGER oauth_clients_updated_at BEFORE UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER oauth_clients_audit AFTER INSERT OR UPDATE OR DELETE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- One-time confirmation for deciding an approval over MCP (plan §5.6, MCP-OA-14/15).
-- grant_id is the credential the token is bound to: the OAuth grant id, or 'pat:<api_tokens.id>'.
CREATE TABLE mcp_confirm_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash        text NOT NULL UNIQUE,
  user_id           uuid NOT NULL REFERENCES users (id),
  grant_id          text NOT NULL CHECK (length(grant_id) > 0),
  approval_id       uuid NOT NULL REFERENCES approvals (id),
  decision          text NOT NULL CHECK (decision IN ('approve', 'reject')),
  outcome           text CHECK (outcome IN ('change_order', 'reject')),  -- never 'absorb' (INV-19)
  note              text,
  approval_version  integer NOT NULL,
  subject_version   integer NOT NULL,
  subject_hash      text NOT NULL,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_confirm_tokens_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX mcp_confirm_tokens_approval_idx ON mcp_confirm_tokens (approval_id);
CREATE INDEX mcp_confirm_tokens_user_idx ON mcp_confirm_tokens (user_id);
CREATE TRIGGER mcp_confirm_tokens_audit AFTER INSERT OR UPDATE ON mcp_confirm_tokens FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- D-MC-3: writes over MCP are off until the pen-test retest. The flag is the settings row 'mcp.writes';
-- no row (the shipped state) or any value but JSON true means off. Admins switch it with mcp.set_writes.

-- Plan §5.7: the trusted client identity is the OAuth client_id (mcp_client) plus the grant.
ALTER TABLE audit_events ADD COLUMN mcp_grant_id text;

-- INV-19 backstop: high-risk kinds and out-of-scope "absorb" are never decided over MCP.
ALTER TABLE approvals ADD CONSTRAINT approvals_inv19_not_over_mcp CHECK (
  decided_channel IS DISTINCT FROM 'mcp'
  OR (kind NOT IN ('margin_floor', 'gate_bypass', 'bypass_review', 'influencer_work') AND outcome IS DISTINCT FROM 'absorb')
);
