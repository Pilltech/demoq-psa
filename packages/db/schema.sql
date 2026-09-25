--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: audit_is_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;


--
-- Name: audit_row_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_row_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_changes (
    id bigint NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    table_name text NOT NULL,
    row_id text,
    op text NOT NULL,
    old_row jsonb,
    new_row jsonb,
    actor_id uuid,
    actor_name text,
    channel text,
    request_id text,
    CONSTRAINT audit_changes_op_check CHECK ((op = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);


--
-- Name: audit_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    actor_name text NOT NULL,
    channel text NOT NULL,
    subject_type text,
    subject_id uuid,
    request_id text NOT NULL,
    on_behalf_of uuid,
    mcp_client text,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome text DEFAULT 'ok'::text NOT NULL,
    error_code text,
    CONSTRAINT audit_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'job'::text, 'influencer_link'::text, 'anonymous'::text]))),
    CONSTRAINT audit_events_channel_check CHECK ((channel = ANY (ARRAY['web'::text, 'telegram'::text, 'mcp'::text, 'job'::text, 'link'::text]))),
    CONSTRAINT audit_events_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'denied'::text])))
);


--
-- Name: audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    name_km text,
    account_lead_id uuid NOT NULL,
    team_id uuid,
    industry text,
    po_required boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    airtable_id text,
    legacy boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clients_name_check CHECK ((length(btrim(name)) > 0))
);


--
-- Name: close_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_reasons (
    code text NOT NULL,
    kind text NOT NULL,
    label_en text NOT NULL,
    label_km text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    legacy_only boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT close_reasons_code_check CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT close_reasons_kind_check CHECK ((kind = ANY (ARRAY['won'::text, 'lost'::text])))
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    full_name text NOT NULL,
    title text,
    email public.citext,
    phone text,
    telegram text,
    is_primary boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    airtable_id text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contacts_full_name_check CHECK ((length(btrim(full_name)) > 0))
);


--
-- Name: deal_stage_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_stage_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    deal_id uuid NOT NULL,
    from_stage text,
    to_stage text NOT NULL,
    close_reason_code text,
    note text,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_stage_history_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.deal_stage_history ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.deal_stage_history_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    title text NOT NULL,
    owner_id uuid NOT NULL,
    stage text DEFAULT 'lead'::text NOT NULL,
    expected_value_minor bigint,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    expected_close_on date,
    close_reason_code text,
    close_reason_kind text,
    close_note text,
    closed_at timestamp with time zone,
    airtable_id text,
    legacy boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deals_close_reason_required CHECK ((((stage = ANY (ARRAY['won'::text, 'lost'::text])) AND (close_reason_code IS NOT NULL) AND (close_reason_kind = stage) AND (closed_at IS NOT NULL)) OR ((stage <> ALL (ARRAY['won'::text, 'lost'::text])) AND (close_reason_code IS NULL) AND (close_reason_kind IS NULL) AND (closed_at IS NULL)))),
    CONSTRAINT deals_currency_check CHECK ((currency = ANY (ARRAY['USD'::bpchar, 'KHR'::bpchar]))),
    CONSTRAINT deals_expected_value_minor_check CHECK ((expected_value_minor >= 0)),
    CONSTRAINT deals_stage_check CHECK ((stage = ANY (ARRAY['lead'::text, 'qualified'::text, 'proposal'::text, 'negotiation'::text, 'won'::text, 'lost'::text]))),
    CONSTRAINT deals_title_check CHECK ((length(btrim(title)) > 0))
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    request_id text NOT NULL,
    delivered_at timestamp with time zone
);


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    totp_verified boolean DEFAULT false NOT NULL,
    ip inet,
    user_agent text,
    CONSTRAINT sessions_check CHECK ((expires_at > created_at))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    name_km text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['ceo'::text, 'director'::text, 'ops_lead'::text, 'finance'::text, 'account_lead'::text, 'project_manager'::text, 'team_lead'::text, 'staff'::text, 'influencer_manager'::text, 'admin'::text, 'viewer'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    display_name text NOT NULL,
    display_name_km text,
    locale text DEFAULT 'en'::text NOT NULL,
    team_id uuid,
    manager_id uuid,
    password_hash text NOT NULL,
    totp_secret_enc text,
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_last_step bigint,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    telegram_user_id bigint,
    working_days smallint[] DEFAULT '{1,2,3,4,5,6}'::smallint[] NOT NULL,
    weekly_capacity_minutes integer DEFAULT 2880 NOT NULL,
    cost_rate_minor bigint,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    totp_failures integer DEFAULT 0 NOT NULL,
    CONSTRAINT users_check CHECK (((manager_id IS NULL) OR (manager_id <> id))),
    CONSTRAINT users_check1 CHECK (((NOT totp_enabled) OR (totp_secret_enc IS NOT NULL))),
    CONSTRAINT users_cost_rate_minor_check CHECK ((cost_rate_minor >= 0)),
    CONSTRAINT users_display_name_check CHECK ((length(btrim(display_name)) > 0)),
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['en'::text, 'km'::text]))),
    CONSTRAINT users_weekly_capacity_minutes_check CHECK ((weekly_capacity_minutes >= 0))
);


--
-- Name: audit_changes audit_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_changes
    ADD CONSTRAINT audit_changes_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: clients clients_airtable_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_airtable_id_key UNIQUE (airtable_id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: close_reasons close_reasons_code_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reasons
    ADD CONSTRAINT close_reasons_code_kind_key UNIQUE (code, kind);


--
-- Name: close_reasons close_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reasons
    ADD CONSTRAINT close_reasons_pkey PRIMARY KEY (code);


--
-- Name: contacts contacts_airtable_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_airtable_id_key UNIQUE (airtable_id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: deal_stage_history deal_stage_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_stage_history
    ADD CONSTRAINT deal_stage_history_pkey PRIMARY KEY (id);


--
-- Name: deal_stage_history deal_stage_history_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_stage_history
    ADD CONSTRAINT deal_stage_history_seq_key UNIQUE (seq);


--
-- Name: deals deals_airtable_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_airtable_id_key UNIQUE (airtable_id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: teams teams_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_name_key UNIQUE (name);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_telegram_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_telegram_user_id_key UNIQUE (telegram_user_id);


--
-- Name: audit_changes_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_changes_row_idx ON public.audit_changes USING btree (table_name, row_id, changed_at DESC);


--
-- Name: audit_events_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_action_idx ON public.audit_events USING btree (action, occurred_at DESC);


--
-- Name: audit_events_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_actor_idx ON public.audit_events USING btree (actor_id, occurred_at DESC);


--
-- Name: audit_events_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_subject_idx ON public.audit_events USING btree (subject_type, subject_id, occurred_at DESC);


--
-- Name: clients_account_lead_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_account_lead_idx ON public.clients USING btree (account_lead_id);


--
-- Name: clients_name_km_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_name_km_trgm_idx ON public.clients USING gin (name_km public.gin_trgm_ops);


--
-- Name: clients_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_name_trgm_idx ON public.clients USING gin (name public.gin_trgm_ops);


--
-- Name: clients_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_team_idx ON public.clients USING btree (team_id);


--
-- Name: contacts_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_client_idx ON public.contacts USING btree (client_id);


--
-- Name: contacts_one_primary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_one_primary_idx ON public.contacts USING btree (client_id) WHERE (is_primary AND (archived_at IS NULL));


--
-- Name: deal_stage_history_changed_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_stage_history_changed_by_idx ON public.deal_stage_history USING btree (changed_by);


--
-- Name: deal_stage_history_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_stage_history_deal_idx ON public.deal_stage_history USING btree (deal_id, seq);


--
-- Name: deals_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_client_idx ON public.deals USING btree (client_id);


--
-- Name: deals_close_reason_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_close_reason_idx ON public.deals USING btree (close_reason_code, close_reason_kind);


--
-- Name: deals_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_owner_idx ON public.deals USING btree (owner_id);


--
-- Name: deals_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_stage_idx ON public.deals USING btree (stage);


--
-- Name: outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending_idx ON public.outbox USING btree (id) WHERE (delivered_at IS NULL);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: users_manager_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_manager_idx ON public.users USING btree (manager_id);


--
-- Name: users_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_team_idx ON public.users USING btree (team_id);


--
-- Name: audit_changes audit_changes_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_changes_append_only BEFORE DELETE OR UPDATE ON public.audit_changes FOR EACH ROW EXECUTE FUNCTION public.audit_is_append_only();


--
-- Name: audit_changes audit_changes_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_changes_no_truncate BEFORE TRUNCATE ON public.audit_changes FOR EACH STATEMENT EXECUTE FUNCTION public.audit_is_append_only();


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_is_append_only();


--
-- Name: audit_events audit_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.audit_is_append_only();


--
-- Name: clients clients_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clients_audit AFTER INSERT OR DELETE OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: clients clients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: close_reasons close_reasons_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER close_reasons_audit AFTER INSERT OR DELETE OR UPDATE ON public.close_reasons FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: close_reasons close_reasons_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER close_reasons_updated_at BEFORE UPDATE ON public.close_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contacts contacts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_audit AFTER INSERT OR DELETE OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: contacts contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deal_stage_history deal_stage_history_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deal_stage_history_audit AFTER INSERT ON public.deal_stage_history FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: deals deals_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deals_audit AFTER INSERT OR DELETE OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: deals deals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deals_updated_at BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: settings settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settings_audit AFTER INSERT OR DELETE OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: settings settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settings_updated_at BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: teams teams_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER teams_audit AFTER INSERT OR DELETE OR UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: teams teams_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER teams_updated_at BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_roles user_roles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_roles_audit AFTER INSERT OR DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: users users_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_audit AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: users users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: clients clients_account_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_account_lead_id_fkey FOREIGN KEY (account_lead_id) REFERENCES public.users(id);


--
-- Name: clients clients_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id);


--
-- Name: contacts contacts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: deal_stage_history deal_stage_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_stage_history
    ADD CONSTRAINT deal_stage_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: deal_stage_history deal_stage_history_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_stage_history
    ADD CONSTRAINT deal_stage_history_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);


--
-- Name: deals deals_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: deals deals_close_reason_code_close_reason_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_close_reason_code_close_reason_kind_fkey FOREIGN KEY (close_reason_code, close_reason_kind) REFERENCES public.close_reasons(code, kind);


--
-- Name: deals deals_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id);


--
-- Name: users users_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id);


--
-- PostgreSQL database dump complete
--


