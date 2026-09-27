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


--
-- Name: quote_lines_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.quote_lines_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF st NOT IN ('draft', 'margin_review', 'ready') THEN
    RAISE EXCEPTION 'QUOTE_LOCKED: lines of a % quote cannot change', st USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;


--
-- Name: quotes_floor_backstop(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.quotes_floor_backstop() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: quotes_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.quotes_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    scopes text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_tokens_check CHECK ((expires_at <= (created_at + '30 days'::interval))),
    CONSTRAINT api_tokens_label_check CHECK ((length(btrim(label)) > 0)),
    CONSTRAINT api_tokens_scopes_check CHECK (((scopes <@ ARRAY['read'::text, 'write'::text]) AND (cardinality(scopes) > 0)))
);


--
-- Name: approval_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    approval_id uuid NOT NULL,
    event text NOT NULL,
    assignee_id uuid,
    assignee_permission_ok boolean,
    actor_name text NOT NULL,
    channel text,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_events_check CHECK (((event <> ALL (ARRAY['created'::text, 'escalated'::text, 'fallback'::text])) OR (assignee_id IS NULL) OR assignee_permission_ok)),
    CONSTRAINT approval_events_event_check CHECK ((event = ANY (ARRAY['created'::text, 'escalated'::text, 'fallback'::text, 'no_eligible'::text, 'approved'::text, 'rejected'::text, 'superseded'::text, 'cancelled'::text])))
);


--
-- Name: approval_events_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.approval_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.approval_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: approval_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_policies (
    kind text NOT NULL,
    label_en text NOT NULL,
    label_km text NOT NULL,
    required_permission text NOT NULL,
    chain text[] NOT NULL,
    sla_minutes integer NOT NULL,
    fallback_approver_id uuid,
    channels_allowed text[] DEFAULT '{web,telegram}'::text[] NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_policies_chain_check CHECK ((cardinality(chain) > 0)),
    CONSTRAINT approval_policies_kind_check CHECK ((kind ~ '^[a-z][a-z_]*$'::text)),
    CONSTRAINT approval_policies_sla_minutes_check CHECK ((sla_minutes > 0))
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    subject_version integer NOT NULL,
    subject_hash text NOT NULL,
    requested_by uuid NOT NULL,
    required_permission text NOT NULL,
    assignee_id uuid,
    escalation_level integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    decided_channel text,
    decision_note text,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    on_approve jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approvals_check CHECK (((status = ANY (ARRAY['approved'::text, 'rejected'::text])) = ((decided_by IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT approvals_decided_channel_check CHECK ((decided_channel = ANY (ARRAY['web'::text, 'telegram'::text, 'mcp'::text, 'job'::text]))),
    CONSTRAINT approvals_escalation_level_check CHECK ((escalation_level >= 0)),
    CONSTRAINT approvals_no_self_approval CHECK (((decided_by IS NULL) OR (decided_by <> requested_by))),
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'superseded'::text])))
);


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
-- Name: engagement_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engagement_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    label_en text NOT NULL,
    label_km text NOT NULL,
    commercial_model text NOT NULL,
    fee_margin_floor_bp integer DEFAULT 2500 NOT NULL,
    passthrough_markup_floor_bp integer,
    passthrough_markup_warn_bp integer DEFAULT 1000 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT engagement_types_code_check CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT engagement_types_commercial_model_check CHECK ((commercial_model = ANY (ARRAY['retainer'::text, 'campaign'::text, 'one_off'::text, 'influencer_program'::text]))),
    CONSTRAINT engagement_types_fee_margin_floor_bp_check CHECK (((fee_margin_floor_bp >= 0) AND (fee_margin_floor_bp <= 10000))),
    CONSTRAINT engagement_types_passthrough_markup_floor_bp_check CHECK (((passthrough_markup_floor_bp >= 0) AND (passthrough_markup_floor_bp <= 10000))),
    CONSTRAINT engagement_types_passthrough_markup_warn_bp_check CHECK (((passthrough_markup_warn_bp >= 0) AND (passthrough_markup_warn_bp <= 10000)))
);


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rate_date date NOT NULL,
    base character(3) DEFAULT 'USD'::bpchar NOT NULL,
    quote character(3) DEFAULT 'KHR'::bpchar NOT NULL,
    rate_micros bigint NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    entered_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fx_rates_base_check CHECK ((base = 'USD'::bpchar)),
    CONSTRAINT fx_rates_quote_check CHECK ((quote = 'KHR'::bpchar)),
    CONSTRAINT fx_rates_rate_micros_check CHECK ((rate_micros > 0)),
    CONSTRAINT fx_rates_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'nbc'::text])))
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
    delivered_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    available_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: project_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    label_en text NOT NULL,
    label_km text NOT NULL,
    default_engagement_type_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_types_code_check CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text))
);


--
-- Name: quote_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    "position" integer NOT NULL,
    kind text NOT NULL,
    rate_card_item_id uuid,
    service_code text,
    description_en text NOT NULL,
    description_km text,
    qty_milli integer NOT NULL,
    unit_price_minor bigint NOT NULL,
    unit_cost_minor bigint NOT NULL,
    list_price_minor bigint,
    discount_bp integer DEFAULT 0 NOT NULL,
    line_price_minor bigint NOT NULL,
    line_cost_minor bigint NOT NULL,
    per_period boolean DEFAULT false NOT NULL,
    quoted_minutes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quote_lines_description_en_check CHECK ((length(btrim(description_en)) > 0)),
    CONSTRAINT quote_lines_discount_bp_check CHECK (((discount_bp >= 0) AND (discount_bp <= 10000))),
    CONSTRAINT quote_lines_kind_check CHECK ((kind = ANY (ARRAY['fee'::text, 'pass_through'::text]))),
    CONSTRAINT quote_lines_line_cost_minor_check CHECK ((line_cost_minor >= 0)),
    CONSTRAINT quote_lines_line_price_minor_check CHECK ((line_price_minor >= 0)),
    CONSTRAINT quote_lines_list_price_minor_check CHECK ((list_price_minor >= 0)),
    CONSTRAINT quote_lines_position_check CHECK (("position" >= 0)),
    CONSTRAINT quote_lines_qty_milli_check CHECK ((qty_milli > 0)),
    CONSTRAINT quote_lines_quoted_minutes_check CHECK ((quoted_minutes >= 0)),
    CONSTRAINT quote_lines_unit_cost_minor_check CHECK ((unit_cost_minor >= 0)),
    CONSTRAINT quote_lines_unit_price_minor_check CHECK ((unit_price_minor >= 0))
);


--
-- Name: quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    client_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    engagement_type_id uuid NOT NULL,
    project_type_id uuid,
    rate_card_id uuid,
    version_no integer DEFAULT 1 NOT NULL,
    supersedes_quote_id uuid,
    title text NOT NULL,
    currency character(3) NOT NULL,
    billing_model text DEFAULT 'one_off'::text NOT NULL,
    period_months integer,
    valid_until date,
    terms text,
    status text DEFAULT 'draft'::text NOT NULL,
    fee_price_minor bigint DEFAULT 0 NOT NULL,
    fee_cost_minor bigint DEFAULT 0 NOT NULL,
    pt_price_minor bigint DEFAULT 0 NOT NULL,
    pt_cost_minor bigint DEFAULT 0 NOT NULL,
    discount_minor bigint DEFAULT 0 NOT NULL,
    total_minor bigint DEFAULT 0 NOT NULL,
    fee_margin_bp integer,
    pt_markup_bp integer,
    below_floor boolean DEFAULT false NOT NULL,
    content_sha256 text DEFAULT ''::text NOT NULL,
    send_on_approval boolean DEFAULT false NOT NULL,
    submitted_by uuid,
    submitted_at timestamp with time zone,
    sent_by uuid,
    sent_at timestamp with time zone,
    fx_rate_micros bigint,
    fx_rate_date date,
    pdf_status text,
    rejected_reason text,
    win_reason_code text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quotes_billing_model_check CHECK ((billing_model = ANY (ARRAY['one_off'::text, 'retainer'::text]))),
    CONSTRAINT quotes_check CHECK (((billing_model = 'retainer'::text) = (period_months IS NOT NULL))),
    CONSTRAINT quotes_check1 CHECK (((status <> ALL (ARRAY['sent'::text, 'accepted'::text, 'rejected'::text, 'expired'::text])) OR ((fx_rate_micros IS NOT NULL) AND (fx_rate_date IS NOT NULL) AND (sent_at IS NOT NULL)))),
    CONSTRAINT quotes_currency_check CHECK ((currency = ANY (ARRAY['USD'::bpchar, 'KHR'::bpchar]))),
    CONSTRAINT quotes_pdf_status_check CHECK ((pdf_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT quotes_period_months_check CHECK (((period_months >= 1) AND (period_months <= 36))),
    CONSTRAINT quotes_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'margin_review'::text, 'ready'::text, 'sent'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'superseded'::text]))),
    CONSTRAINT quotes_title_check CHECK ((length(btrim(title)) > 0)),
    CONSTRAINT quotes_version_no_check CHECK ((version_no > 0))
);


--
-- Name: rate_card_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_card_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rate_card_id uuid NOT NULL,
    service_code text NOT NULL,
    kind text NOT NULL,
    label_en text NOT NULL,
    label_km text NOT NULL,
    unit text NOT NULL,
    unit_price_minor bigint NOT NULL,
    unit_cost_minor bigint NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_card_items_kind_check CHECK ((kind = ANY (ARRAY['fee'::text, 'pass_through'::text]))),
    CONSTRAINT rate_card_items_service_code_check CHECK ((service_code ~ '^[A-Z0-9][A-Z0-9_-]*$'::text)),
    CONSTRAINT rate_card_items_unit_check CHECK ((unit = ANY (ARRAY['hour'::text, 'day'::text, 'item'::text, 'post'::text, 'month'::text, 'lump'::text]))),
    CONSTRAINT rate_card_items_unit_cost_minor_check CHECK ((unit_cost_minor >= 0)),
    CONSTRAINT rate_card_items_unit_price_minor_check CHECK ((unit_price_minor >= 0))
);


--
-- Name: rate_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    currency character(3) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_cards_currency_check CHECK ((currency = ANY (ARRAY['USD'::bpchar, 'KHR'::bpchar])))
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
    step_up_at timestamp with time zone,
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
-- Name: telegram_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_actions (
    token text NOT NULL,
    approval_id uuid NOT NULL,
    user_id uuid NOT NULL,
    telegram_user_id bigint NOT NULL,
    decision text NOT NULL,
    subject_version integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_actions_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text, 'confirm_approve'::text]))),
    CONSTRAINT telegram_actions_token_check CHECK (((length(token) >= 8) AND (length(token) <= 40)))
);


--
-- Name: telegram_link_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_link_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: approval_events approval_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_events
    ADD CONSTRAINT approval_events_pkey PRIMARY KEY (id);


--
-- Name: approval_events approval_events_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_events
    ADD CONSTRAINT approval_events_seq_key UNIQUE (seq);


--
-- Name: approval_policies approval_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_pkey PRIMARY KEY (kind);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


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
-- Name: engagement_types engagement_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engagement_types
    ADD CONSTRAINT engagement_types_code_key UNIQUE (code);


--
-- Name: engagement_types engagement_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engagement_types
    ADD CONSTRAINT engagement_types_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_rate_date_base_quote_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_rate_date_base_quote_key UNIQUE (rate_date, base, quote);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: project_types project_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_code_key UNIQUE (code);


--
-- Name: project_types project_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_pkey PRIMARY KEY (id);


--
-- Name: quote_lines quote_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_lines
    ADD CONSTRAINT quote_lines_pkey PRIMARY KEY (id);


--
-- Name: quote_lines quote_lines_quote_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_lines
    ADD CONSTRAINT quote_lines_quote_id_position_key UNIQUE (quote_id, "position");


--
-- Name: quotes quotes_deal_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_deal_id_version_no_key UNIQUE (deal_id, version_no);


--
-- Name: quotes quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);


--
-- Name: rate_card_items rate_card_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_card_items
    ADD CONSTRAINT rate_card_items_pkey PRIMARY KEY (id);


--
-- Name: rate_card_items rate_card_items_rate_card_id_service_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_card_items
    ADD CONSTRAINT rate_card_items_rate_card_id_service_code_key UNIQUE (rate_card_id, service_code);


--
-- Name: rate_cards rate_cards_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_cards
    ADD CONSTRAINT rate_cards_name_key UNIQUE (name);


--
-- Name: rate_cards rate_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_cards
    ADD CONSTRAINT rate_cards_pkey PRIMARY KEY (id);


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
-- Name: telegram_actions telegram_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_actions
    ADD CONSTRAINT telegram_actions_pkey PRIMARY KEY (token);


--
-- Name: telegram_link_codes telegram_link_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_link_codes
    ADD CONSTRAINT telegram_link_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: telegram_link_codes telegram_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_link_codes
    ADD CONSTRAINT telegram_link_codes_pkey PRIMARY KEY (id);


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
-- Name: api_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id);


--
-- Name: approval_events_approval_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_events_approval_idx ON public.approval_events USING btree (approval_id, seq);


--
-- Name: approval_events_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_events_assignee_idx ON public.approval_events USING btree (assignee_id);


--
-- Name: approval_policies_fallback_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_policies_fallback_idx ON public.approval_policies USING btree (fallback_approver_id);


--
-- Name: approvals_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_assignee_idx ON public.approvals USING btree (assignee_id) WHERE (status = 'pending'::text);


--
-- Name: approvals_decided_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_decided_by_idx ON public.approvals USING btree (decided_by);


--
-- Name: approvals_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_due_idx ON public.approvals USING btree (due_at) WHERE (status = 'pending'::text);


--
-- Name: approvals_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approvals_one_pending ON public.approvals USING btree (kind, subject_type, subject_id) WHERE (status = 'pending'::text);


--
-- Name: approvals_requested_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_requested_by_idx ON public.approvals USING btree (requested_by);


--
-- Name: approvals_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_subject_idx ON public.approvals USING btree (subject_type, subject_id);


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
-- Name: fx_rates_entered_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fx_rates_entered_by_idx ON public.fx_rates USING btree (entered_by);


--
-- Name: outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending_idx ON public.outbox USING btree (id) WHERE (delivered_at IS NULL);


--
-- Name: project_types_engagement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_types_engagement_idx ON public.project_types USING btree (default_engagement_type_id);


--
-- Name: quote_lines_rate_card_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quote_lines_rate_card_item_idx ON public.quote_lines USING btree (rate_card_item_id);


--
-- Name: quotes_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_client_idx ON public.quotes USING btree (client_id);


--
-- Name: quotes_engagement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_engagement_idx ON public.quotes USING btree (engagement_type_id);


--
-- Name: quotes_one_accepted_per_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quotes_one_accepted_per_deal ON public.quotes USING btree (deal_id) WHERE (status = 'accepted'::text);


--
-- Name: quotes_one_sent_per_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quotes_one_sent_per_deal ON public.quotes USING btree (deal_id) WHERE (status = 'sent'::text);


--
-- Name: quotes_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_owner_idx ON public.quotes USING btree (owner_id);


--
-- Name: quotes_project_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_project_type_idx ON public.quotes USING btree (project_type_id);


--
-- Name: quotes_rate_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_rate_card_idx ON public.quotes USING btree (rate_card_id);


--
-- Name: quotes_sent_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_sent_by_idx ON public.quotes USING btree (sent_by);


--
-- Name: quotes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_status_idx ON public.quotes USING btree (status);


--
-- Name: quotes_submitted_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_submitted_by_idx ON public.quotes USING btree (submitted_by);


--
-- Name: quotes_supersedes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quotes_supersedes_idx ON public.quotes USING btree (supersedes_quote_id);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: telegram_actions_approval_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_actions_approval_idx ON public.telegram_actions USING btree (approval_id);


--
-- Name: telegram_actions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_actions_user_idx ON public.telegram_actions USING btree (user_id);


--
-- Name: telegram_link_codes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_link_codes_user_idx ON public.telegram_link_codes USING btree (user_id);


--
-- Name: users_manager_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_manager_idx ON public.users USING btree (manager_id);


--
-- Name: users_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_team_idx ON public.users USING btree (team_id);


--
-- Name: api_tokens api_tokens_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER api_tokens_audit AFTER INSERT OR UPDATE ON public.api_tokens FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: approval_events approval_events_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_events_audit AFTER INSERT ON public.approval_events FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: approval_policies approval_policies_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_policies_audit AFTER INSERT OR DELETE OR UPDATE ON public.approval_policies FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: approval_policies approval_policies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_policies_updated_at BEFORE UPDATE ON public.approval_policies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: approvals approvals_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_audit AFTER INSERT OR DELETE OR UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: approvals approvals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_updated_at BEFORE UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: engagement_types engagement_types_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER engagement_types_audit AFTER INSERT OR DELETE OR UPDATE ON public.engagement_types FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: engagement_types engagement_types_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER engagement_types_updated_at BEFORE UPDATE ON public.engagement_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: fx_rates fx_rates_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fx_rates_audit AFTER INSERT OR DELETE OR UPDATE ON public.fx_rates FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: fx_rates fx_rates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fx_rates_updated_at BEFORE UPDATE ON public.fx_rates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: project_types project_types_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_types_audit AFTER INSERT OR DELETE OR UPDATE ON public.project_types FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: project_types project_types_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_types_updated_at BEFORE UPDATE ON public.project_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quote_lines quote_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quote_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.quote_lines FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: quote_lines quote_lines_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quote_lines_lock BEFORE INSERT OR DELETE OR UPDATE ON public.quote_lines FOR EACH ROW EXECUTE FUNCTION public.quote_lines_lock();


--
-- Name: quote_lines quote_lines_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quote_lines_updated_at BEFORE UPDATE ON public.quote_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quotes quotes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quotes_audit AFTER INSERT OR DELETE OR UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: quotes quotes_floor_backstop; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quotes_floor_backstop BEFORE INSERT OR UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.quotes_floor_backstop();


--
-- Name: quotes quotes_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quotes_lock BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.quotes_lock();


--
-- Name: quotes quotes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: rate_card_items rate_card_items_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rate_card_items_audit AFTER INSERT OR DELETE OR UPDATE ON public.rate_card_items FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: rate_card_items rate_card_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rate_card_items_updated_at BEFORE UPDATE ON public.rate_card_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: rate_cards rate_cards_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rate_cards_audit AFTER INSERT OR DELETE OR UPDATE ON public.rate_cards FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: rate_cards rate_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rate_cards_updated_at BEFORE UPDATE ON public.rate_cards FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: telegram_actions telegram_actions_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_actions_audit AFTER INSERT OR UPDATE ON public.telegram_actions FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


--
-- Name: telegram_link_codes telegram_link_codes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_link_codes_audit AFTER INSERT OR UPDATE ON public.telegram_link_codes FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();


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
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: approval_events approval_events_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_events
    ADD CONSTRAINT approval_events_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.approvals(id);


--
-- Name: approval_events approval_events_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_events
    ADD CONSTRAINT approval_events_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id);


--
-- Name: approval_policies approval_policies_fallback_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_fallback_approver_id_fkey FOREIGN KEY (fallback_approver_id) REFERENCES public.users(id);


--
-- Name: approvals approvals_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id);


--
-- Name: approvals approvals_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);


--
-- Name: approvals approvals_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_kind_fkey FOREIGN KEY (kind) REFERENCES public.approval_policies(kind);


--
-- Name: approvals approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


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
-- Name: fx_rates fx_rates_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id);


--
-- Name: project_types project_types_default_engagement_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_default_engagement_type_id_fkey FOREIGN KEY (default_engagement_type_id) REFERENCES public.engagement_types(id);


--
-- Name: quote_lines quote_lines_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_lines
    ADD CONSTRAINT quote_lines_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.quotes(id);


--
-- Name: quote_lines quote_lines_rate_card_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_lines
    ADD CONSTRAINT quote_lines_rate_card_item_id_fkey FOREIGN KEY (rate_card_item_id) REFERENCES public.rate_card_items(id);


--
-- Name: quotes quotes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: quotes quotes_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);


--
-- Name: quotes quotes_engagement_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_engagement_type_id_fkey FOREIGN KEY (engagement_type_id) REFERENCES public.engagement_types(id);


--
-- Name: quotes quotes_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: quotes quotes_project_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_project_type_id_fkey FOREIGN KEY (project_type_id) REFERENCES public.project_types(id);


--
-- Name: quotes quotes_rate_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_rate_card_id_fkey FOREIGN KEY (rate_card_id) REFERENCES public.rate_cards(id);


--
-- Name: quotes quotes_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id);


--
-- Name: quotes quotes_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);


--
-- Name: quotes quotes_supersedes_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_supersedes_quote_id_fkey FOREIGN KEY (supersedes_quote_id) REFERENCES public.quotes(id);


--
-- Name: rate_card_items rate_card_items_rate_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_card_items
    ADD CONSTRAINT rate_card_items_rate_card_id_fkey FOREIGN KEY (rate_card_id) REFERENCES public.rate_cards(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: telegram_actions telegram_actions_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_actions
    ADD CONSTRAINT telegram_actions_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.approvals(id);


--
-- Name: telegram_actions telegram_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_actions
    ADD CONSTRAINT telegram_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: telegram_link_codes telegram_link_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_link_codes
    ADD CONSTRAINT telegram_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


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


