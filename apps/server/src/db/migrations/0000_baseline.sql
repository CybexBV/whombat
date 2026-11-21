-- The next chain's baseline (docs/decisions/report-trackers.md): the schema 0000_baseline … 0076_trackers make, in one
-- migration, at the version 0076_trackers has (77). Made by src/scripts/next-baseline.ts with pg_dump --schema-only
-- of a fresh database that chain migrated, and proven equal to it (trackers/bridge/takeover.int.test.ts). A database
-- of the old chain takes it over once (trackers/bridge/takeover.ts); never edit this file.
CREATE FUNCTION public.events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'Signed audit events can never be changed or removed.';
END;
$$;
--> statement-breakpoint
CREATE SEQUENCE public.authz_generation_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
CREATE TABLE public.accounts (
    id text NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    preferences jsonb DEFAULT '{"theme": "system", "timeZone": null}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    email_verified_at timestamp with time zone,
    authz_generation integer DEFAULT nextval('public.authz_generation_seq'::regclass) NOT NULL,
    notifications_emailed_at timestamp with time zone,
    avatar jsonb
);
--> statement-breakpoint
CREATE TABLE public.activities (
    id text NOT NULL,
    burrow_id text NOT NULL,
    dispatch_id text NOT NULL,
    run_id text,
    agent_id text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    key text NOT NULL,
    attempt integer NOT NULL,
    seq integer NOT NULL,
    kind text NOT NULL,
    tool text NOT NULL,
    status text NOT NULL,
    title text NOT NULL,
    object text,
    detail text,
    important boolean NOT NULL,
    exit_code integer,
    failure text,
    key_needed text,
    approval_id text,
    evidence jsonb,
    rev bigint NOT NULL,
    started_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone
);
--> statement-breakpoint
CREATE SEQUENCE public.activities_rev_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.activities_rev_seq OWNED BY public.activities.rev;
--> statement-breakpoint
CREATE TABLE public.agent_schedules (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    for_account_id text NOT NULL,
    prompt text NOT NULL,
    "when" jsonb NOT NULL,
    status text NOT NULL,
    ended_reason text,
    next_at timestamp with time zone,
    ends_at timestamp with time zone,
    anchor_at timestamp with time zone NOT NULL,
    runs integer DEFAULT 0 NOT NULL,
    last_run_at timestamp with time zone,
    created_by_dispatch_id text,
    message_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.appliance_claim_attempts (
    id integer NOT NULL,
    peer_id text NOT NULL,
    ok integer DEFAULT 0 NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE public.appliance_claim_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.appliance_claim_attempts_id_seq OWNED BY public.appliance_claim_attempts.id;
--> statement-breakpoint
CREATE TABLE public.appliance_claim_failures (
    id integer NOT NULL,
    method text NOT NULL,
    peer_id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE public.appliance_claim_failures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.appliance_claim_failures_id_seq OWNED BY public.appliance_claim_failures.id;
--> statement-breakpoint
CREATE TABLE public.appliance_endpoints (
    id text NOT NULL,
    peer_id text NOT NULL,
    public_key text NOT NULL,
    account_id text NOT NULL,
    label text NOT NULL,
    platform text NOT NULL,
    enrolled_via text NOT NULL,
    enrolled_by_endpoint_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by_account_id text,
    revocation_reported_at timestamp with time zone,
    push_handle text,
    enrolled_passkey_id text,
    app_build text
);
--> statement-breakpoint
CREATE TABLE public.appliance_events (
    seq bigint NOT NULL,
    type text NOT NULL,
    actor_account_id text,
    endpoint_id text,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    prev_hash text NOT NULL,
    hash text NOT NULL,
    sig text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.appliance_keys (
    id text NOT NULL,
    public_key text NOT NULL,
    secret_key_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.appliance_passkeys (
    id text NOT NULL,
    account_id text NOT NULL,
    name text NOT NULL,
    public_key bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    backup_eligible boolean NOT NULL,
    backed_up boolean NOT NULL,
    created_by_endpoint_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    last_endpoint_id text,
    removed_at timestamp with time zone,
    removed_by_account_id text,
    owner_handle text
);
--> statement-breakpoint
CREATE TABLE public.appliance_state (
    id integer NOT NULL,
    claim_device_id text,
    claim_secret_hash text,
    claim_consumed_at timestamp with time zone,
    claimed_by_account_id text,
    claim_window_required integer DEFAULT 0 NOT NULL,
    claim_window_until timestamp with time zone,
    claim_reported_at timestamp with time zone,
    recovery_public_key text,
    recovery_enrolled_at timestamp with time zone,
    recovery_kit_verified_at timestamp with time zone,
    recovery_kit_id text,
    recovery_challenge text,
    recovery_challenge_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_id text,
    recovery_owner_account_id text,
    recovery_pending_public_key text,
    recovery_pending_owner_account_id text,
    client_floor jsonb,
    licence_token text,
    licence_high_water timestamp with time zone,
    licence_clock_mark timestamp with time zone,
    passkeys_device_bound_only boolean DEFAULT false NOT NULL,
    remote_help_seq bigint,
    remote_help_host_key text,
    vapid_public_key text,
    vapid_private_key_enc text,
    mail_settings jsonb,
    mail_password_enc text
);
--> statement-breakpoint
CREATE TABLE public.approvals (
    id text NOT NULL,
    burrow_id text NOT NULL,
    number integer NOT NULL,
    requester_id text NOT NULL,
    key_id text,
    action jsonb NOT NULL,
    title text NOT NULL,
    question text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    what_happens jsonb DEFAULT '[]'::jsonb NOT NULL,
    explainer text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    conditions jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    decided_by_id text,
    decided_at timestamp with time zone,
    execution jsonb NOT NULL,
    executed_at timestamp with time zone,
    conversation_id text NOT NULL,
    message_id text,
    involved_ids text[] DEFAULT '{}'::text[] NOT NULL,
    event_id text,
    command jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    action_hash text,
    action_binding jsonb,
    what_happens_outside jsonb,
    on_behalf_of_account_id text,
    scope text,
    execute_at timestamp with time zone,
    result_enc text,
    created_by_dispatch_id text,
    run_id text
);
--> statement-breakpoint
CREATE TABLE public.assistant_states (
    burrow_id text NOT NULL,
    person_id text NOT NULL,
    account_id text NOT NULL,
    welcomed_at timestamp with time zone,
    suggested_at timestamp with time zone,
    suggested_topic text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.attachments (
    id text NOT NULL,
    burrow_id text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size integer NOT NULL,
    url text NOT NULL,
    uploaded_by_id text NOT NULL,
    message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    conversation_id text,
    declared_type text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'file'::text NOT NULL,
    sha256 text,
    blob_key text,
    width integer,
    height integer,
    state text DEFAULT 'reserved'::text NOT NULL,
    uploaded_at timestamp with time zone,
    folder text DEFAULT ''::text NOT NULL,
    filed_at timestamp with time zone,
    files_removed_at timestamp with time zone,
    files_removed_by text,
    thumbnail_width integer,
    thumbnail_height integer,
    filed_by text
);
--> statement-breakpoint
CREATE TABLE public.automation_cursors (
    burrow_id text NOT NULL,
    seq integer NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automation_destinations (
    burrow_id text NOT NULL,
    url text NOT NULL,
    approved_by_id text NOT NULL,
    approved_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automation_plans (
    id text NOT NULL,
    burrow_id text NOT NULL,
    automation_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    definition jsonb NOT NULL,
    definition_hash text NOT NULL,
    grants jsonb NOT NULL,
    base_version integer,
    base_grants jsonb,
    thinking jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    message_id text,
    created_by_dispatch_id text,
    decided_by_id text,
    decided_at timestamp with time zone,
    version integer,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automation_run_steps (
    run_id text NOT NULL,
    idx integer NOT NULL,
    step_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    idempotency_key text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    wake_at timestamp with time zone,
    deadline_at timestamp with time zone,
    input_summary text DEFAULT ''::text NOT NULL,
    output jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    dispatch_id text,
    approval_id text,
    prompt_message_id text,
    message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    pr_number integer,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automation_runs (
    id text NOT NULL,
    burrow_id text NOT NULL,
    number integer NOT NULL,
    automation_id text NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    published_by_id text NOT NULL,
    status text NOT NULL,
    trigger jsonb NOT NULL,
    trigger_key text NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    causal_depth integer DEFAULT 0 NOT NULL,
    causal_chain text[] DEFAULT '{}'::text[] NOT NULL,
    started_by_id text,
    test boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    deadline_at timestamp with time zone NOT NULL,
    error text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    fence integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    on_behalf_of_account_id text,
    item_key text
);
--> statement-breakpoint
CREATE TABLE public.automation_versions (
    automation_id text NOT NULL,
    n integer NOT NULL,
    definition jsonb NOT NULL,
    definition_hash text NOT NULL,
    published_by_id text NOT NULL,
    published_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automations (
    id text NOT NULL,
    burrow_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version integer,
    draft_json jsonb,
    draft_updated_by_id text,
    draft_updated_at timestamp with time zone,
    principal_id text NOT NULL,
    created_by_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    webhook_enabled boolean DEFAULT false NOT NULL,
    webhook_secret_enc text,
    next_fire_at timestamp with time zone,
    schedule_anchor timestamp with time zone,
    deleted_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.backup_files (
    id text NOT NULL,
    burrow_id text NOT NULL,
    made_by_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    categories jsonb NOT NULL,
    includes_secrets boolean NOT NULL,
    progress jsonb,
    size bigint,
    sha256 text,
    path text,
    error jsonb,
    created_at timestamp with time zone NOT NULL,
    ready_at timestamp with time zone,
    expires_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.backup_key_state (
    appliance text NOT NULL,
    adopted_from text,
    adopted_reported_at timestamp with time zone,
    details_digest text,
    paper_repository_id text,
    paper_generation integer,
    paper_digest text,
    paper_at timestamp with time zone,
    nas_at timestamp with time zone,
    nas_digest text,
    nas_where text,
    nas_tried_at timestamp with time zone,
    kit_ensured_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.backup_passkey_keys (
    appliance text NOT NULL,
    credential_id text NOT NULL,
    account_id text NOT NULL,
    salt text NOT NULL,
    key_sealed text NOT NULL,
    envelope text,
    generation integer,
    locked_digest text,
    locked_at timestamp with time zone,
    stored_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.backup_places (
    id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    client text NOT NULL,
    address text,
    port integer,
    by_hand boolean DEFAULT false NOT NULL,
    repository_id text,
    cleanup_at timestamp with time zone,
    pending_password_enc text,
    pending_until timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    location text,
    cleanup_keep jsonb
);
--> statement-breakpoint
CREATE TABLE public.backup_restore_map (
    burrow_id text NOT NULL,
    source_burrow_id text NOT NULL,
    source_id text NOT NULL,
    category text NOT NULL,
    target_id text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.backup_restores (
    id text NOT NULL,
    burrow_id text NOT NULL,
    restored_by_id text NOT NULL,
    upload_id text,
    file_name text NOT NULL,
    made_at timestamp with time zone NOT NULL,
    source_name text NOT NULL,
    source_burrow_id text NOT NULL,
    categories jsonb NOT NULL,
    on_different text NOT NULL,
    status text NOT NULL,
    progress jsonb,
    summary jsonb,
    error jsonb,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.backup_uploads (
    id text NOT NULL,
    burrow_id text NOT NULL,
    uploaded_by_id text NOT NULL,
    file_name text NOT NULL,
    size bigint NOT NULL,
    sha256 text,
    received bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    path text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    uploaded_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.box_backup (
    id integer NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.box_network (
    id integer NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.briefs (
    id text NOT NULL,
    burrow_id text NOT NULL,
    person_id text NOT NULL,
    kind text NOT NULL,
    day text NOT NULL,
    window_from timestamp with time zone NOT NULL,
    window_to timestamp with time zone NOT NULL,
    time_zone text NOT NULL,
    content jsonb NOT NULL,
    facts jsonb NOT NULL,
    lead text,
    state text NOT NULL,
    dispatch_id text,
    conversation_id text,
    message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    posted_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.burrows (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    time_zone text DEFAULT 'UTC'::text NOT NULL,
    onboarding jsonb DEFAULT '{"step": 0, "completedAt": null, "githubConnected": false}'::jsonb NOT NULL,
    created_by_account_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    link_previews boolean,
    agents_reach_lan boolean,
    ai_gateway jsonb,
    host_disk_alert integer DEFAULT 0 NOT NULL,
    backup_defaults jsonb,
    backup_defaults_at timestamp with time zone,
    host_power_alert integer DEFAULT 0 NOT NULL,
    local_model jsonb,
    local_model_key_enc text,
    agent_notes jsonb,
    change_window_start text,
    change_window_end text,
    care_baseline_due boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.canvas_comments (
    id text NOT NULL,
    canvas_id text NOT NULL,
    burrow_id text NOT NULL,
    anchor jsonb,
    parent_id text,
    author_id text NOT NULL,
    text text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.canvas_updates (
    id bigint NOT NULL,
    canvas_id text NOT NULL,
    update bytea NOT NULL,
    author_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE public.canvas_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.canvas_updates_id_seq OWNED BY public.canvas_updates.id;
--> statement-breakpoint
CREATE TABLE public.canvases (
    id text NOT NULL,
    burrow_id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    conversation_id text,
    plan_id text,
    provenance jsonb NOT NULL,
    markdown text DEFAULT ''::text NOT NULL,
    ydoc bytea,
    ydoc_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.catalog_connections (
    id text NOT NULL,
    catalog_id text NOT NULL,
    burrow_id text NOT NULL,
    connected_by_id text,
    label text NOT NULL,
    handle text NOT NULL,
    transport text NOT NULL,
    sign_in text NOT NULL,
    base_url text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    auth jsonb,
    secret_enc text,
    refresh_token_enc text,
    access_token_enc text,
    access_expires_at timestamp with time zone,
    client_id text,
    issuer text,
    resource text,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    external_name text,
    status text DEFAULT 'active'::text NOT NULL,
    reauth_reason text,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    checked_at timestamp with time zone,
    tool_count integer DEFAULT 0 NOT NULL,
    tools_synced_at timestamp with time zone,
    repair_notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    access text DEFAULT 'manage'::text NOT NULL,
    client_secret_enc text,
    glance jsonb,
    glance_at timestamp with time zone,
    runs_on jsonb,
    last_worked_at timestamp with time zone,
    remembered_enc text,
    scopes_wanted text[] DEFAULT '{}'::text[] NOT NULL,
    logo jsonb,
    page jsonb
);
--> statement-breakpoint
CREATE TABLE public.changes (
    id text NOT NULL,
    burrow_id text NOT NULL,
    actor_id text NOT NULL,
    agent_id text,
    person_id text,
    kind text NOT NULL,
    title text NOT NULL,
    detail text,
    subject_kind text,
    subject_id text,
    subject_name text,
    undo_kind text,
    undo_enc text,
    undo_until timestamp with time zone,
    link jsonb,
    conversation_id text,
    undone_at timestamp with time zone,
    undone_by_id text,
    undo_change_id text,
    created_at timestamp with time zone NOT NULL,
    merge_key text,
    merge_fields jsonb,
    undo_asked_at timestamp with time zone,
    undo_asked_by_id text,
    thread_root_id text
);
--> statement-breakpoint
CREATE TABLE public.chat_thread_runtimes (
    root_id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    runtime jsonb NOT NULL,
    set_by_id text NOT NULL,
    set_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.check_server_actions (
    id text NOT NULL,
    burrow_id text NOT NULL,
    check_server_id text NOT NULL,
    repo text NOT NULL,
    key text NOT NULL,
    labels jsonb NOT NULL,
    lane jsonb NOT NULL,
    from_pool text,
    created_by_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.check_server_asks (
    id text NOT NULL,
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    place_id text,
    repo text,
    message_id text NOT NULL,
    created_by_id text,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.check_server_clients (
    id text NOT NULL,
    burrow_id text NOT NULL,
    check_server_id text NOT NULL,
    server_id text NOT NULL,
    slug text NOT NULL,
    fingerprint text,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.check_server_computers (
    id text NOT NULL,
    burrow_id text NOT NULL,
    check_server_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    public_key text,
    fingerprint text,
    created_by_id text,
    created_at timestamp with time zone NOT NULL,
    added_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.check_servers (
    id text NOT NULL,
    burrow_id text NOT NULL,
    name text NOT NULL,
    mode text NOT NULL,
    state text NOT NULL,
    problem text,
    server_id text,
    plan jsonb,
    limits jsonb,
    command text NOT NULL,
    result_check text,
    needs_push boolean DEFAULT false NOT NULL,
    runner_version integer,
    receipt jsonb,
    proof jsonb,
    prove_with jsonb,
    created_by_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    label text,
    take_over jsonb,
    ci_problem text,
    vm_proof jsonb
);
--> statement-breakpoint
CREATE TABLE public.command_allowances (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    key_id text NOT NULL,
    command text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    created_by_id text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.command_passes (
    approval_id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    dispatch_id text NOT NULL,
    run_id text,
    conversation_id text NOT NULL,
    thread_root_id text,
    category text NOT NULL,
    key_id text NOT NULL,
    command text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    scope text,
    polled_at timestamp with time zone,
    delivered_at timestamp with time zone,
    used_at timestamp with time zone,
    woken_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.command_receipts (
    principal_id text NOT NULL,
    op text NOT NULL,
    request_id text NOT NULL,
    digest text NOT NULL,
    state text NOT NULL,
    endpoint_id text,
    outcome jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    finished_at timestamp with time zone,
    deadline_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.connection_clients (
    id text NOT NULL,
    issuer text NOT NULL,
    client_enc text NOT NULL,
    redirect_uri text NOT NULL,
    method text NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.connection_events (
    connection_id text NOT NULL,
    event_id text NOT NULL,
    at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    device text,
    title text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.connection_found_hidden (
    burrow_id text NOT NULL,
    catalog_id text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    hidden_by text,
    hidden_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.connection_found_state (
    burrow_id text NOT NULL,
    first_scan_at timestamp with time zone,
    told_at timestamp with time zone,
    put_away_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.connection_pending (
    id text NOT NULL,
    account_id text NOT NULL,
    burrow_id text,
    catalog_id text NOT NULL,
    connection_id text,
    sign_in text NOT NULL,
    state_enc text NOT NULL,
    return_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.connection_points (
    connection_id text NOT NULL,
    at timestamp with time zone NOT NULL,
    key text NOT NULL,
    value double precision
);
--> statement-breakpoint
CREATE TABLE public.connection_tools (
    connection_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    input_schema jsonb,
    access text NOT NULL,
    tier text NOT NULL,
    hash text NOT NULL,
    is_new boolean DEFAULT false NOT NULL,
    origin text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    limits jsonb
);
--> statement-breakpoint
CREATE TABLE public.connections (
    id text NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    external_id text NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    services text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    refresh_token_enc text NOT NULL,
    access_token_enc text,
    access_expires_at timestamp with time zone,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    reauth_reason text,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    checked_at timestamp with time zone,
    repair_notified_at timestamp with time zone,
    mail_settings jsonb
);
--> statement-breakpoint
CREATE TABLE public.connector_apps (
    provider text NOT NULL,
    client_id text NOT NULL,
    client_secret_enc text NOT NULL,
    user_type text NOT NULL,
    updated_by_account_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.conversations (
    id text NOT NULL,
    burrow_id text NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    topic text DEFAULT ''::text NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    pr_number integer,
    repo_id text,
    dm_agent_id text,
    dm_person_id text,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    link_previews boolean,
    task_key text,
    chat_title text,
    chat_retitled_at timestamp with time zone,
    chat_subject_kind text,
    chat_subject_id text,
    chat_subject_name text,
    chat_archived_at timestamp with time zone,
    room_cleared_at timestamp with time zone,
    notify text
);
--> statement-breakpoint
CREATE TABLE public.council_members (
    id text NOT NULL,
    council_id text NOT NULL,
    burrow_id text NOT NULL,
    role text NOT NULL,
    stage text NOT NULL,
    round integer NOT NULL,
    "position" integer NOT NULL,
    provider text NOT NULL,
    provider_name text NOT NULL,
    model text NOT NULL,
    label text NOT NULL,
    options jsonb NOT NULL,
    thread_id text,
    url text,
    state text NOT NULL,
    score real,
    verdict text,
    answer text,
    step text,
    dispatch_id text,
    stop_pending boolean DEFAULT false NOT NULL,
    stop_tries integer DEFAULT 0 NOT NULL,
    stop_next_at timestamp with time zone,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    deadline timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.council_setups (
    id text NOT NULL,
    burrow_id text NOT NULL,
    name text NOT NULL,
    seats jsonb NOT NULL,
    builder integer DEFAULT 0 NOT NULL,
    rounds integer NOT NULL,
    target real NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.council_shots (
    council_id text NOT NULL,
    burrow_id text NOT NULL,
    view text NOT NULL,
    "position" integer NOT NULL,
    before_id text,
    after_id text,
    compare_id text,
    width integer,
    height integer,
    areas jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.councils (
    id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    agent_id text NOT NULL,
    person_id text,
    connection_id text NOT NULL,
    project_id text,
    project_title text,
    project_root text,
    kind text NOT NULL,
    seats jsonb NOT NULL,
    title text NOT NULL,
    question text NOT NULL,
    stage text NOT NULL,
    round integer DEFAULT 1 NOT NULL,
    agree_rounds integer DEFAULT 0 NOT NULL,
    check_rounds integer DEFAULT 0 NOT NULL,
    rounds_max integer NOT NULL,
    target real,
    go_all_the_way boolean DEFAULT false NOT NULL,
    ok_at timestamp with time zone,
    plan text,
    instructions text,
    builder_thread_id text,
    builder_worktree text,
    builder_branch text,
    live_message_id text,
    final_message_id text,
    upload_hash text,
    upload_until timestamp with time zone,
    history jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    outcome text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    builder_seat integer DEFAULT 0 NOT NULL,
    setup_name text
);
--> statement-breakpoint
CREATE TABLE public.delegation_shots (
    task_id text NOT NULL,
    delegation_id text NOT NULL,
    burrow_id text NOT NULL,
    view text NOT NULL,
    "position" integer NOT NULL,
    before_id text,
    after_id text,
    compare_id text,
    width integer,
    height integer,
    areas jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.delegation_tasks (
    id text NOT NULL,
    delegation_id text NOT NULL,
    burrow_id text NOT NULL,
    "position" integer NOT NULL,
    title text NOT NULL,
    why text,
    brief text NOT NULL,
    picked boolean DEFAULT true NOT NULL,
    after_id text,
    provider text,
    model text,
    model_label text,
    state text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    thread_id text,
    url text,
    worktree text,
    branch text,
    pr text,
    note text,
    answer text,
    dispatch_id text,
    stop_pending boolean DEFAULT false NOT NULL,
    stop_tries integer DEFAULT 0 NOT NULL,
    stop_next_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    deadline timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    merge_state text,
    merge_answer text,
    areas text[] DEFAULT '{}'::text[] NOT NULL,
    options jsonb,
    checks text,
    send_pending text,
    upload_hash text,
    upload_until timestamp with time zone,
    kind text DEFAULT 'task'::text NOT NULL,
    group_id text,
    checked_revision text,
    checked_inputs text,
    checked_base text,
    check_generation integer DEFAULT 0 NOT NULL,
    checked_generation integer,
    checks_stuck_at timestamp with time zone,
    item integer,
    merge_claimed_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.delegations (
    id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    agent_id text NOT NULL,
    person_id text,
    connection_id text NOT NULL,
    project_id text,
    project_title text,
    project_root text,
    title text NOT NULL,
    stage text NOT NULL,
    at_once integer NOT NULL,
    pull_requests boolean DEFAULT true NOT NULL,
    note text,
    message_id text,
    handed_at timestamp with time zone,
    outcome text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    merge boolean DEFAULT false NOT NULL,
    council_id text,
    rules text,
    base_branch text,
    ai_provider text,
    ai_model text,
    ai_model_label text,
    ai_options jsonb,
    integration_mode text DEFAULT 'batch'::text NOT NULL,
    delivery jsonb
);
--> statement-breakpoint
CREATE TABLE public.deployments (
    id text NOT NULL,
    burrow_id text NOT NULL,
    environment text NOT NULL,
    environment_key text NOT NULL,
    service text NOT NULL,
    service_key text NOT NULL,
    status text NOT NULL,
    how text NOT NULL,
    repo text,
    ref text,
    sha text,
    url text,
    summary text NOT NULL,
    by_id text NOT NULL,
    run_id text,
    conversation_id text,
    message_id text,
    previous_id text,
    dispatch_id text,
    approval_id text,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.desk_display (
    id integer NOT NULL,
    screen_on boolean,
    updated_at timestamp with time zone NOT NULL,
    whombat_name text,
    CONSTRAINT desk_display_one CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE public.desk_screens (
    id integer NOT NULL,
    burrow_id text NOT NULL,
    person_id text NOT NULL,
    pin_hash text,
    locked_view text DEFAULT 'summary'::text NOT NULL,
    quiet_enabled boolean DEFAULT true NOT NULL,
    quiet_start text DEFAULT '23:00'::text NOT NULL,
    quiet_end text DEFAULT '07:00'::text NOT NULL,
    night text DEFAULT 'dim'::text NOT NULL,
    voice boolean DEFAULT true NOT NULL,
    paired_at timestamp with time zone NOT NULL,
    wrong_pins integer DEFAULT 0 NOT NULL,
    retry_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    paired_via text DEFAULT 'letters'::text NOT NULL,
    pin_digits smallint,
    presence boolean DEFAULT false NOT NULL,
    speech_voice text DEFAULT 'heart'::text NOT NULL,
    stay_unlocked boolean DEFAULT false NOT NULL,
    camera_wake boolean DEFAULT false NOT NULL,
    unlocked_boot text,
    show jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT desk_screens_locked_view CHECK ((locked_view = ANY (ARRAY['time'::text, 'summary'::text, 'everything'::text]))),
    CONSTRAINT desk_screens_night CHECK ((night = ANY (ARRAY['dim'::text, 'black'::text]))),
    CONSTRAINT desk_screens_one CHECK ((id = 1)),
    CONSTRAINT desk_screens_paired_via CHECK ((paired_via = ANY (ARRAY['letters'::text, 'itself'::text, 'switch'::text]))),
    CONSTRAINT desk_screens_pin_digits CHECK (((pin_digits >= 4) AND (pin_digits <= 6))),
    CONSTRAINT desk_screens_quiet CHECK (((quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text) AND (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))),
    CONSTRAINT desk_screens_speech_voice CHECK ((speech_voice ~ '^[a-z][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT desk_screens_unlocked_boot CHECK ((unlocked_boot ~ '^[A-Za-z0-9-]{1,64}$'::text))
);
--> statement-breakpoint
CREATE TABLE public.device_skills (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text,
    person_id text,
    conversation_id text,
    message_id text,
    name text NOT NULL,
    profile jsonb NOT NULL,
    profile_hash text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    unit_id integer,
    tested jsonb NOT NULL,
    tested_at timestamp with time zone NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    choices jsonb,
    connection_id text,
    decided_by_id text,
    decided_at timestamp with time zone,
    last_read jsonb,
    last_read_at timestamp with time zone,
    last_read_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.devices (
    id text NOT NULL,
    account_id text NOT NULL,
    platform text NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    web_push jsonb,
    name text,
    live_activity_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.diagnostic_bundles (
    id text NOT NULL,
    scopes jsonb NOT NULL,
    bundle jsonb NOT NULL,
    created_by_account_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    size integer NOT NULL,
    sha256 text NOT NULL,
    downloads integer DEFAULT 0 NOT NULL,
    last_downloaded_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.dispatches (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    trigger text NOT NULL,
    mode text DEFAULT 'reply'::text NOT NULL,
    conversation_id text NOT NULL,
    message_id text,
    thread_root_id text,
    run_id text,
    state text DEFAULT 'queued'::text NOT NULL,
    provider_session_id text,
    runner_id text,
    error text,
    search jsonb,
    token_hash text,
    token_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    finished_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    not_before timestamp with time zone,
    cancel_reason text,
    usage jsonb,
    posted_at timestamp with time zone,
    on_behalf_of_account_id text,
    plan_id text,
    plan_step_id text,
    approval_id text,
    retry_of_id text,
    failure jsonb,
    requeued_for text,
    schedule_id text,
    stopped_by_id text,
    gateway_provider text,
    gateway_account text,
    runtime jsonb,
    served_tools text[],
    waits_on jsonb
);
--> statement-breakpoint
CREATE TABLE public.done_tasks (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    person_id text,
    conversation_id text NOT NULL,
    thread_root_id text,
    summary text NOT NULL,
    dispatch_id text,
    reported_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.endpoint_device_links (
    id text NOT NULL,
    account_id text NOT NULL,
    created_by_endpoint_id text NOT NULL,
    secret_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by_endpoint_id text,
    replaced_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.endpoint_pairings (
    id text NOT NULL,
    code text NOT NULL,
    peer_id text NOT NULL,
    public_key text NOT NULL,
    label text NOT NULL,
    platform text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    decided_by_endpoint_id text,
    endpoint_id text
);
--> statement-breakpoint
CREATE TABLE public.events (
    id text NOT NULL,
    burrow_id text NOT NULL,
    seq integer NOT NULL,
    v integer DEFAULT 1 NOT NULL,
    prev_hash text NOT NULL,
    actor_id text NOT NULL,
    type text NOT NULL,
    kind text NOT NULL,
    text text,
    "where" text,
    key_used jsonb,
    key_note text,
    on_behalf_of text,
    on_behalf_of_id text,
    about_id text,
    decided jsonb,
    approval_id text,
    ref jsonb,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    hash text NOT NULL,
    sig text NOT NULL,
    signer text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feature_requests (
    id text NOT NULL,
    burrow_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    attempt integer NOT NULL,
    automation_id text NOT NULL,
    connection_id text NOT NULL,
    connection text NOT NULL,
    report_id text NOT NULL,
    number bigint NOT NULL,
    title text NOT NULL,
    organization text,
    agent text NOT NULL,
    value integer,
    value_why text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    importance text NOT NULL,
    size text NOT NULL,
    approved_reply text DEFAULT ''::text NOT NULL,
    declined_reply text DEFAULT ''::text NOT NULL,
    decline_reason text DEFAULT ''::text NOT NULL,
    signature text NOT NULL,
    can_build boolean DEFAULT false NOT NULL,
    state text DEFAULT 'waiting'::text NOT NULL,
    choice text,
    note text,
    decided_by_id text,
    decided_at timestamp with time zone,
    message_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback_assessments (
    id text NOT NULL,
    burrow_id text NOT NULL,
    report_id text NOT NULL,
    integration_id text NOT NULL,
    attempt integer NOT NULL,
    agent_id text NOT NULL,
    dispatch_id text,
    state text NOT NULL,
    error text,
    workspace jsonb,
    can_execute boolean DEFAULT false NOT NULL,
    requested_by_id text,
    started_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    workspace_commit text,
    finished_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.feedback_drop_expired (
    site_id text NOT NULL,
    day date NOT NULL,
    count integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback_drop_keys (
    kid text NOT NULL,
    kind text NOT NULL,
    public_key text NOT NULL,
    private_sealed text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    current_since timestamp with time zone NOT NULL,
    retired_at timestamp with time zone,
    delete_after timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.feedback_drop_outcomes (
    drop_id text NOT NULL,
    site_id text NOT NULL,
    integration_id text,
    outcome text NOT NULL,
    code text,
    attempts integer DEFAULT 0 NOT NULL,
    at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback_drop_sites (
    site_id text NOT NULL,
    integration_id text NOT NULL,
    published_at timestamp with time zone,
    card_seq bigint,
    expires_at timestamp with time zone,
    refused text,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback_drop_state (
    id integer NOT NULL,
    card_seq bigint DEFAULT 0 NOT NULL,
    synced_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.feedback_integrations (
    id text NOT NULL,
    burrow_id text NOT NULL,
    site_id text NOT NULL,
    intake text DEFAULT 'enabled'::text NOT NULL,
    assessment text DEFAULT 'active'::text NOT NULL,
    channel_id text NOT NULL,
    settings jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    config_hash text NOT NULL,
    created_by_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_by_id text NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback_reports (
    id text NOT NULL,
    burrow_id text NOT NULL,
    integration_id text NOT NULL,
    reference text NOT NULL,
    submission_id text NOT NULL,
    payload_hash text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    expected text DEFAULT ''::text NOT NULL,
    steps text DEFAULT ''::text NOT NULL,
    reporter_name text,
    reporter_email text,
    context jsonb,
    attachment_ids text[] DEFAULT '{}'::text[] NOT NULL,
    content_removed_at timestamp with time zone,
    intake jsonb NOT NULL,
    conversation_id text NOT NULL,
    root_message_id text NOT NULL,
    assessment_state text NOT NULL,
    assessment_reason text,
    assessment jsonb,
    assessment_attempts integer DEFAULT 0 NOT NULL,
    assessment_dispatch_id text,
    assessment_lease_expires_at timestamp with time zone,
    assessment_not_before timestamp with time zone,
    assessment_requested_by_id text,
    assessment_updated_at timestamp with time zone NOT NULL,
    handoff_approval_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    reporter_id text,
    reporter_verified boolean DEFAULT false NOT NULL,
    reporter_published_at timestamp with time zone,
    reporter_dirty boolean DEFAULT false NOT NULL,
    conclusion jsonb,
    decided jsonb,
    assessment_message_id text
);
--> statement-breakpoint
CREATE TABLE public.followed_tasks (
    id text NOT NULL,
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    task_id text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    agent_id text NOT NULL,
    person_id text,
    approval_id text,
    words jsonb NOT NULL,
    server_name text NOT NULL,
    message_id text,
    state text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    checked_at timestamp with time zone,
    result text,
    reboot_required boolean DEFAULT false NOT NULL,
    dispatch_id text,
    change_enc text
);
--> statement-breakpoint
CREATE TABLE public.gateway_usage (
    connection_id text NOT NULL,
    burrow_id text NOT NULL,
    accounts jsonb DEFAULT '[]'::jsonb NOT NULL,
    faults jsonb DEFAULT '[]'::jsonb NOT NULL,
    reachable boolean DEFAULT true NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    observed_at timestamp with time zone,
    checked_at timestamp with time zone,
    failing_since timestamp with time zone,
    error text,
    alerts jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.github_branch_heads (
    burrow_id text NOT NULL,
    repo text NOT NULL,
    branch text NOT NULL,
    sha text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.github_connections (
    burrow_id text NOT NULL,
    login text,
    github_user_id bigint,
    connected_by_id text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.github_deploys (
    approval_id text NOT NULL,
    burrow_id text NOT NULL,
    repo text NOT NULL,
    workflow text NOT NULL,
    ref text NOT NULL,
    environment text NOT NULL,
    state text DEFAULT 'dispatched'::text NOT NULL,
    run_id bigint,
    run_url text,
    dispatched_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.github_identities (
    burrow_id text NOT NULL,
    login text NOT NULL,
    principal_id text NOT NULL,
    github_user_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.github_issues (
    id text NOT NULL,
    burrow_id text NOT NULL,
    repo text NOT NULL,
    number integer NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    author_login text,
    author_bot boolean DEFAULT false NOT NULL,
    url text NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    seen_at timestamp with time zone NOT NULL,
    author_association text,
    assignees text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.github_poll_cursors (
    burrow_id text NOT NULL,
    repo text NOT NULL,
    baseline_at timestamp with time zone NOT NULL,
    etags jsonb DEFAULT '{}'::jsonb NOT NULL,
    known_prs jsonb DEFAULT '[]'::jsonb NOT NULL,
    refreshed_at timestamp with time zone,
    polled_at timestamp with time zone,
    error text,
    issues_since timestamp with time zone,
    issues_after integer
);
--> statement-breakpoint
CREATE TABLE public.github_push_grants (
    id text NOT NULL,
    burrow_id text NOT NULL,
    repo text NOT NULL,
    branch text NOT NULL,
    agent_id text NOT NULL,
    dispatch_id text,
    on_behalf_of jsonb,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    sha text
);
--> statement-breakpoint
CREATE TABLE public.github_seen (
    burrow_id text NOT NULL,
    repo text NOT NULL,
    key text NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.grants (
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    key_id text NOT NULL,
    tier text NOT NULL,
    scope jsonb,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.hermes_session_drops (
    home text NOT NULL,
    session_id text NOT NULL,
    dropped_at timestamp with time zone NOT NULL,
    handed_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.kept_sites (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    origins jsonb NOT NULL,
    site text NOT NULL,
    hours integer NOT NULL,
    cookies_sealed text NOT NULL,
    kept_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.link_previews (
    burrow_id text NOT NULL,
    url text NOT NULL,
    preview jsonb,
    status text NOT NULL,
    reason text,
    fetched_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.live_activities (
    id integer NOT NULL,
    device_id text NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    push_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE public.live_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.live_activities_id_seq OWNED BY public.live_activities.id;
--> statement-breakpoint
CREATE TABLE public.look_researches (
    id text NOT NULL,
    burrow_id text NOT NULL,
    agent_id text NOT NULL,
    person_id text,
    look_key text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    check_id text,
    subject text DEFAULT ''::text NOT NULL,
    rank integer NOT NULL,
    reason text,
    question text,
    since timestamp with time zone,
    state text NOT NULL,
    title text,
    summary text,
    fix_label text,
    fix_step text,
    conversation_id text,
    thread_root_id text,
    dispatch_id text,
    started_at timestamp with time zone NOT NULL,
    state_at timestamp with time zone NOT NULL,
    reported_at timestamp with time zone,
    gone_at timestamp with time zone,
    lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    plan jsonb,
    asked_by_id text,
    plan_message_id text,
    pushed_at timestamp with time zone,
    care jsonb
);
--> statement-breakpoint
CREATE TABLE public.merge_intents (
    id text NOT NULL,
    burrow_id text NOT NULL,
    pr_id text NOT NULL,
    actor_id text NOT NULL,
    head_sha text NOT NULL,
    base_branch text NOT NULL,
    method text NOT NULL,
    key_id text NOT NULL,
    on_behalf_of jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text NOT NULL,
    reason text,
    merge_sha text,
    event_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.messages (
    id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    author_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    ord bigint NOT NULL,
    edited_at timestamp with time zone,
    text text NOT NULL,
    mentions text[] DEFAULT '{}'::text[] NOT NULL,
    card jsonb,
    attachment_ids text[] DEFAULT '{}'::text[] NOT NULL,
    thread_root_id text,
    reply_count integer DEFAULT 0 NOT NULL,
    last_reply_at timestamp with time zone,
    thread_participant_ids text[] DEFAULT '{}'::text[] NOT NULL,
    client_id text,
    suggestions text[] DEFAULT '{}'::text[] NOT NULL,
    more jsonb,
    asks boolean DEFAULT false NOT NULL,
    provenance text,
    deleted_at timestamp with time zone,
    pinned_at timestamp with time zone,
    pinned_by_id text,
    previews jsonb,
    subject_kind text,
    subject_id text,
    subject_name text,
    ran_on jsonb,
    dispatch_id text,
    vault_saved jsonb,
    settled_at timestamp with time zone,
    settled_how text,
    kept_open_at timestamp with time zone,
    moved_card jsonb,
    earlier_card jsonb,
    CONSTRAINT messages_settled CHECK ((((settled_at IS NULL) = (settled_how IS NULL)) AND ((settled_how IS NULL) OR (settled_how = ANY (ARRAY['person'::text, 'quiet'::text, 'merged'::text, 'resolved'::text])))))
);
--> statement-breakpoint
ALTER TABLE public.messages ALTER COLUMN ord ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.messages_ord_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
--> statement-breakpoint
CREATE TABLE public.needs_you_snoozes (
    burrow_id text NOT NULL,
    person_id text NOT NULL,
    ref_kind text NOT NULL,
    ref_id text NOT NULL,
    state text DEFAULT 'snoozed'::text NOT NULL,
    until timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notice_quiets (
    owner_id text NOT NULL,
    thing_id text NOT NULL,
    check_id text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    state text NOT NULL,
    lifts text,
    episode text,
    tone text NOT NULL,
    band integer,
    until timestamp with time zone,
    clear_passes integer DEFAULT 0 NOT NULL,
    title text NOT NULL,
    subject_name text,
    words text,
    by_id text,
    at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notice_states (
    thing_id text NOT NULL,
    check_id text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    first_seen timestamp with time zone NOT NULL,
    last_seen timestamp with time zone NOT NULL,
    seen_passes integer NOT NULL,
    tone text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notifications (
    id text NOT NULL,
    burrow_id text NOT NULL,
    principal_id text NOT NULL,
    kind text NOT NULL,
    actor_id text NOT NULL,
    "where" text DEFAULT ''::text NOT NULL,
    text text NOT NULL,
    link jsonb NOT NULL,
    approval_id text,
    created_at timestamp with time zone NOT NULL,
    read_at timestamp with time zone,
    dedup_key text,
    message_id text,
    emailed_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.oauth_states (
    id text NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    services text[] NOT NULL,
    code_verifier text NOT NULL,
    return_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.outbox (
    id bigint NOT NULL,
    burrow_id text,
    topic text NOT NULL,
    event jsonb NOT NULL,
    event_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);
--> statement-breakpoint
CREATE SEQUENCE public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.outbox_id_seq OWNED BY public.outbox.id;
--> statement-breakpoint
CREATE TABLE public.personal_schedules (
    id text NOT NULL,
    burrow_id text NOT NULL,
    account_id text NOT NULL,
    person_id text NOT NULL,
    agent_id text NOT NULL,
    kind text NOT NULL,
    cron text NOT NULL,
    time_zone text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.plans (
    id text NOT NULL,
    burrow_id text NOT NULL,
    title text NOT NULL,
    due date,
    conversation_id text NOT NULL,
    canvas_id text,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_id text,
    created_at timestamp with time zone,
    source_message_id text,
    source_thread_root_id text,
    message_id text
);
--> statement-breakpoint
CREATE TABLE public.pr_checks (
    pr_id text NOT NULL,
    name text NOT NULL,
    state text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    duration_ms integer,
    tests jsonb,
    url text,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.pr_commits (
    pr_id text NOT NULL,
    sha text NOT NULL,
    message text NOT NULL,
    author_id text,
    at timestamp with time zone NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.pr_files (
    pr_id text NOT NULL,
    path text NOT NULL,
    add integer NOT NULL,
    del integer NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.pr_reviewers (
    pr_id text NOT NULL,
    principal_id text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    at timestamp with time zone,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.principals (
    id text NOT NULL,
    burrow_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    handle text NOT NULL,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    secret_key_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id text,
    short_name text,
    initials text,
    tone text,
    title text,
    email text,
    status text,
    doing text,
    job text,
    runtime jsonb,
    "position" integer DEFAULT 0 NOT NULL,
    system text,
    avatar_attachment_id text,
    avatar_url text,
    model_fallback jsonb,
    agent_face text
);
--> statement-breakpoint
CREATE TABLE public.prompts (
    id text NOT NULL,
    burrow_id text NOT NULL,
    starter_key text,
    title text,
    text text,
    on_repository boolean DEFAULT true NOT NULL,
    own_it boolean DEFAULT false NOT NULL,
    ai jsonb,
    hidden boolean DEFAULT false NOT NULL,
    runs jsonb DEFAULT '[]'::jsonb NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.pull_requests (
    id text NOT NULL,
    burrow_id text NOT NULL,
    repo_id text NOT NULL,
    number integer NOT NULL,
    branch text NOT NULL,
    base_branch text DEFAULT 'main'::text NOT NULL,
    title text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    head_sha text NOT NULL,
    author_id text,
    diff jsonb DEFAULT '{"add": 0, "del": 0, "files": 0}'::jsonb NOT NULL,
    conversation_id text NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    merged_at timestamp with time zone,
    merged_by_id text,
    url text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    local_only boolean DEFAULT false NOT NULL,
    checks_handled_sha text,
    draft boolean DEFAULT false NOT NULL,
    author_login text,
    author_bot boolean DEFAULT false NOT NULL,
    body text,
    author_association text,
    assignees text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.reactions (
    message_id text NOT NULL,
    principal_id text NOT NULL,
    value text NOT NULL,
    burrow_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.read_states (
    conversation_id text NOT NULL,
    principal_id text NOT NULL,
    last_read_message_id text,
    last_read_at timestamp with time zone,
    last_read_ord bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.repo_night_runs (
    id text NOT NULL,
    burrow_id text NOT NULL,
    place_id text NOT NULL,
    repo text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    revision text,
    state text NOT NULL,
    jobs jsonb NOT NULL,
    words text,
    by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.repo_places (
    id text NOT NULL,
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    folder text NOT NULL,
    root text,
    snapshot jsonb,
    read_at timestamp with time zone,
    problem text,
    added_by_id text,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.repo_rules (
    id text NOT NULL,
    burrow_id text NOT NULL,
    place_id text NOT NULL,
    repo text NOT NULL,
    path text NOT NULL,
    rules jsonb NOT NULL,
    write boolean NOT NULL,
    set_by_id text,
    set_at timestamp with time zone NOT NULL,
    last_write jsonb,
    active boolean DEFAULT true NOT NULL,
    pending jsonb
);
--> statement-breakpoint
CREATE TABLE public.repo_setups (
    id text NOT NULL,
    burrow_id text NOT NULL,
    place_id text NOT NULL,
    repo text NOT NULL,
    state text NOT NULL,
    lines jsonb NOT NULL,
    facts jsonb,
    answers jsonb NOT NULL,
    plan jsonb,
    plan_hash text,
    practice jsonb,
    practiced_hash text,
    files_thread jsonb,
    problem text,
    started_by text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    goal text DEFAULT 'recommended'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.repos (
    id text NOT NULL,
    burrow_id text NOT NULL,
    full_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    language text,
    default_branch text DEFAULT 'main'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    pushed_at timestamp with time zone,
    github_repo_id bigint,
    "position" integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'github'::text NOT NULL,
    origin_path text,
    created_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.run_files (
    run_id text NOT NULL,
    path text NOT NULL,
    add integer NOT NULL,
    del integer NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.run_log (
    run_id text NOT NULL,
    seq integer NOT NULL,
    at timestamp with time zone NOT NULL,
    text text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.run_steps (
    run_id text NOT NULL,
    idx integer NOT NULL,
    title text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    at timestamp with time zone,
    state text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.runs (
    id text NOT NULL,
    burrow_id text NOT NULL,
    number integer NOT NULL,
    agent_id text NOT NULL,
    title text NOT NULL,
    branch text NOT NULL,
    repo_id text,
    pr_number integer,
    status text NOT NULL,
    asked_by_id text NOT NULL,
    conversation_id text NOT NULL,
    message_id text,
    dispatch_id text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    progress double precision DEFAULT 0 NOT NULL,
    activity text DEFAULT ''::text NOT NULL,
    summary text,
    tests jsonb,
    diff jsonb DEFAULT '{"add": 0, "del": 0, "files": 0}'::jsonb NOT NULL,
    keys_used text[] DEFAULT '{}'::text[] NOT NULL,
    log_count integer DEFAULT 0 NOT NULL,
    paused_by_id text,
    taken_over_by_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attention text,
    stalled_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.screens (
    id text NOT NULL,
    burrow_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    popups text NOT NULL,
    layout jsonb NOT NULL,
    show jsonb DEFAULT '{}'::jsonb NOT NULL,
    endpoint_id text,
    person_id text,
    device text,
    width integer,
    height integer,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT screens_id CHECK ((id ~ '^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$'::text)),
    CONSTRAINT screens_kind CHECK ((kind = ANY (ARRAY['box'::text, 'output'::text, 'device'::text]))),
    CONSTRAINT screens_popups CHECK ((popups = ANY (ARRAY['all'::text, 'problems'::text, 'none'::text]))),
    CONSTRAINT screens_size CHECK (((width IS NULL) = (height IS NULL)))
);
--> statement-breakpoint
CREATE TABLE public.search_answers (
    id text NOT NULL,
    burrow_id text NOT NULL,
    query text NOT NULL,
    agent_id text NOT NULL,
    asked_by_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    duration_ms integer,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.search_documents (
    id text NOT NULL,
    burrow_id text NOT NULL,
    type text NOT NULL,
    conversation_id text,
    "where" text DEFAULT ''::text NOT NULL,
    author_id text NOT NULL,
    text text NOT NULL,
    link jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tsv tsvector GENERATED ALWAYS AS ((to_tsvector('english'::regconfig, ((COALESCE("where", ''::text) || ' '::text) || text)) || to_tsvector('simple'::regconfig, ((COALESCE("where", ''::text) || ' '::text) || text)))) STORED NOT NULL,
    status jsonb
);
--> statement-breakpoint
CREATE TABLE public.server_asks (
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    asks_first text NOT NULL,
    changed_by_id text,
    changed_at timestamp with time zone NOT NULL,
    CONSTRAINT server_asks_value CHECK ((asks_first = ANY (ARRAY['risky'::text, 'never'::text])))
);
--> statement-breakpoint
CREATE TABLE public.server_cares (
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    state text NOT NULL,
    self boolean DEFAULT false NOT NULL,
    research_id text,
    automations jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT server_cares_state CHECK ((state = ANY (ARRAY['known'::text, 'offered'::text])))
);
--> statement-breakpoint
CREATE TABLE public.server_names (
    burrow_id text NOT NULL,
    server_id text NOT NULL,
    name text NOT NULL,
    changed_by_id text,
    changed_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.server_runner_facts (
    server_id text NOT NULL,
    burrow_id text NOT NULL,
    facts jsonb,
    problem text,
    read_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.session_events (
    id bigint NOT NULL,
    burrow_id text,
    topic text NOT NULL,
    event jsonb NOT NULL,
    event_id text,
    at text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE public.session_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.session_events_id_seq OWNED BY public.session_events.id;
--> statement-breakpoint
CREATE TABLE public.session_uploads (
    attachment_id text NOT NULL,
    account_id text NOT NULL,
    sha256 text NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.shares (
    id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    root_id text NOT NULL,
    from_message_id text,
    created_by_id text,
    title text NOT NULL,
    key_enc text NOT NULL,
    viewer_url text,
    messages integer NOT NULL,
    pictures boolean NOT NULL,
    bytes integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    stopped_at timestamp with time zone,
    stop_pending boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.subscription_usage (
    account_id text NOT NULL,
    provider text NOT NULL,
    kind text DEFAULT 'subscription'::text NOT NULL,
    plan text,
    windows jsonb DEFAULT '[]'::jsonb NOT NULL,
    observed_at timestamp with time zone,
    source text,
    error text,
    probed_at timestamp with time zone,
    refreshed_at timestamp with time zone,
    used_at timestamp with time zone,
    alerts jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.t3_watches (
    burrow_id text NOT NULL,
    connection_id text NOT NULL,
    thread_id text NOT NULL,
    title text NOT NULL,
    conversation_id text NOT NULL,
    thread_root_id text,
    agent_id text NOT NULL,
    person_id text,
    state text DEFAULT 'watching'::text NOT NULL,
    seen_key text,
    told jsonb,
    dispatch_id text,
    armed_at timestamp with time zone NOT NULL,
    checked_at timestamp with time zone,
    items integer DEFAULT 0 NOT NULL,
    wakes boolean DEFAULT true NOT NULL,
    status text,
    pending text,
    asks text,
    steps jsonb,
    program text,
    url text,
    prs jsonb,
    run_started_at timestamp with time zone,
    run_ended_at timestamp with time zone,
    council_id text,
    delegation_task_id text,
    branch text,
    project_id text,
    progress jsonb
);
--> statement-breakpoint
CREATE TABLE public.thread_places (
    root_id text NOT NULL,
    burrow_id text NOT NULL,
    conversation_id text NOT NULL,
    place text NOT NULL,
    title text NOT NULL,
    project text,
    placed_by text NOT NULL,
    moved_at timestamp with time zone NOT NULL,
    seen_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.thread_reads (
    root_id text NOT NULL,
    principal_id text NOT NULL,
    last_read_ord bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.tracker_cursors (
    connection_id text NOT NULL,
    burrow_id text NOT NULL,
    since timestamp with time zone,
    after bigint,
    checked_at timestamp with time zone,
    succeeded_at timestamp with time zone,
    problem_code text,
    problem text,
    updated_at timestamp with time zone NOT NULL,
    health_environment text,
    health_version text,
    health_revision text,
    health_checked_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.tracker_fixes (
    id text NOT NULL,
    burrow_id text NOT NULL,
    connection_id text NOT NULL,
    report_id text NOT NULL,
    number bigint NOT NULL,
    run_id text,
    step_idx integer,
    automation_id text,
    repo text NOT NULL,
    pr_number integer NOT NULL,
    pr_url text,
    kind text NOT NULL,
    language text DEFAULT ''::text NOT NULL,
    signature text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    merge_sha text,
    merged_at timestamp with time zone,
    development_host text,
    development_version text,
    development_at timestamp with time zone,
    production_host text,
    production_version text,
    production_at timestamp with time zone,
    development_checked text,
    production_checked text,
    development_request_id text,
    production_request_id text,
    note text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.tracker_grants (
    run_id text NOT NULL,
    step_id text NOT NULL,
    attempt integer NOT NULL,
    burrow_id text NOT NULL,
    connection_id text NOT NULL,
    report_id text NOT NULL,
    token_sealed text,
    reason text,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    organization_id text,
    expires_at timestamp with time zone,
    calls integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.tracker_items (
    id text NOT NULL,
    burrow_id text NOT NULL,
    connection_id text NOT NULL,
    external_id text NOT NULL,
    number bigint NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    organization text,
    environment text,
    version text,
    page text,
    browser text,
    status text NOT NULL,
    priority text,
    has_screenshot boolean DEFAULT false NOT NULL,
    has_diagnostics boolean DEFAULT false NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    expected text DEFAULT ''::text NOT NULL,
    reported_at timestamp with time zone,
    mirrored_at timestamp with time zone NOT NULL,
    seen_status text,
    seen_updated_at timestamp with time zone,
    seen_reporter_messages integer,
    seen_reporter_at timestamp with time zone,
    organization_id text,
    product text DEFAULT 'the tracker'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.tracker_replies (
    id text NOT NULL,
    burrow_id text NOT NULL,
    report_row_id text NOT NULL,
    event text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.tracker_updates (
    request_id text NOT NULL,
    burrow_id text NOT NULL,
    run_id text NOT NULL,
    by_id text NOT NULL,
    message_id text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.upload_reservations (
    id text NOT NULL,
    burrow_id text NOT NULL,
    rate_key text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.vault_entries (
    id text NOT NULL,
    burrow_id text NOT NULL,
    owner_id text NOT NULL,
    owner_account_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    url text,
    auth jsonb,
    sealed text,
    secret_set_at timestamp with time zone,
    tool_key text NOT NULL,
    detail_salt text NOT NULL,
    check_status text DEFAULT 'unchecked'::text NOT NULL,
    check_outcome text,
    check_summary text DEFAULT ''::text NOT NULL,
    check_http_status integer,
    checked_at timestamp with time zone,
    tool_count integer,
    tools_ignored integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    totp_sealed text,
    saved_by_id text,
    totp_set_at timestamp with time zone,
    agent_on_at timestamp with time zone,
    env_name text,
    agent_servers text[]
);
--> statement-breakpoint
CREATE TABLE public.vault_networks (
    id text NOT NULL,
    cidr text NOT NULL,
    ports integer[] NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    added_by_account_id text,
    added_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.vault_ssh_servers (
    id text NOT NULL,
    burrow_id text NOT NULL,
    entry_id text NOT NULL,
    name text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    username text NOT NULL,
    host_key_algorithm text,
    host_key_fingerprint text,
    host_key_trusted_at timestamp with time zone,
    seen_host_key_algorithm text,
    seen_host_key_fingerprint text,
    seen_host_key_at timestamp with time zone,
    check_status text DEFAULT 'unchecked'::text NOT NULL,
    check_outcome text,
    check_summary text DEFAULT ''::text NOT NULL,
    checked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    production boolean DEFAULT false NOT NULL,
    host_key_blob text,
    password_sealed text,
    password_set_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.vault_tools (
    entry_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    input_schema jsonb,
    hash text NOT NULL,
    enabled boolean NOT NULL,
    is_new boolean NOT NULL,
    mcp_name text,
    "position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.vault_uses (
    id text NOT NULL,
    burrow_id text NOT NULL,
    entry_id text NOT NULL,
    agent_id text NOT NULL,
    requester_id text,
    dispatch_id text,
    what text NOT NULL,
    outcome text NOT NULL,
    status integer,
    ms integer DEFAULT 0 NOT NULL,
    bytes integer,
    event_id text,
    at timestamp with time zone NOT NULL,
    server text,
    exit_code integer
);
--> statement-breakpoint
CREATE TABLE public.voice_typing (
    id integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    model text DEFAULT 'auto'::text NOT NULL,
    language text DEFAULT 'auto'::text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT voice_typing_language CHECK ((language = ANY (ARRAY['auto'::text, 'en'::text, 'nl'::text]))),
    CONSTRAINT voice_typing_model CHECK ((model = ANY (ARRAY['auto'::text, 'parakeet'::text, 'whisper'::text]))),
    CONSTRAINT voice_typing_one CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE public.watch_offs (
    owner_id text NOT NULL,
    thing_id text NOT NULL,
    check_id text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    subject_name text,
    by_id text,
    at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.watch_ons (
    owner_id text NOT NULL,
    thing_id text NOT NULL,
    check_id text NOT NULL,
    by_id text,
    at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.widget_points (
    widget_id text NOT NULL,
    t timestamp with time zone NOT NULL,
    "values" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.widgets (
    id text NOT NULL,
    burrow_id text NOT NULL,
    owner_id text NOT NULL,
    agent_id text,
    title text NOT NULL,
    subtitle text,
    kind text DEFAULT 'line'::text NOT NULL,
    source jsonb NOT NULL,
    series jsonb NOT NULL,
    refresh_sec integer DEFAULT 300 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    from_conversation_id text,
    last_error text,
    refreshed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    thing_id text
);
--> statement-breakpoint
ALTER TABLE ONLY public.activities ALTER COLUMN rev SET DEFAULT nextval('public.activities_rev_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_claim_attempts ALTER COLUMN id SET DEFAULT nextval('public.appliance_claim_attempts_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_claim_failures ALTER COLUMN id SET DEFAULT nextval('public.appliance_claim_failures_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.canvas_updates ALTER COLUMN id SET DEFAULT nextval('public.canvas_updates_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.live_activities ALTER COLUMN id SET DEFAULT nextval('public.live_activities_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.outbox ALTER COLUMN id SET DEFAULT nextval('public.outbox_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.session_events ALTER COLUMN id SET DEFAULT nextval('public.session_events_id_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_unique UNIQUE (email);
--> statement-breakpoint
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_schedules
    ADD CONSTRAINT agent_schedules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_claim_attempts
    ADD CONSTRAINT appliance_claim_attempts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_claim_failures
    ADD CONSTRAINT appliance_claim_failures_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_endpoints
    ADD CONSTRAINT appliance_endpoints_peer_id_unique UNIQUE (peer_id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_endpoints
    ADD CONSTRAINT appliance_endpoints_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_events
    ADD CONSTRAINT appliance_events_pkey PRIMARY KEY (seq);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_keys
    ADD CONSTRAINT appliance_keys_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_passkeys
    ADD CONSTRAINT appliance_passkeys_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_state
    ADD CONSTRAINT appliance_state_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_states
    ADD CONSTRAINT assistant_states_burrow_id_person_id_pk PRIMARY KEY (burrow_id, person_id);
--> statement-breakpoint
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_cursors
    ADD CONSTRAINT automation_cursors_pkey PRIMARY KEY (burrow_id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_destinations
    ADD CONSTRAINT automation_destinations_burrow_id_url_pk PRIMARY KEY (burrow_id, url);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_plans
    ADD CONSTRAINT automation_plans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_run_steps
    ADD CONSTRAINT automation_run_steps_run_id_idx_pk PRIMARY KEY (run_id, idx);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_versions
    ADD CONSTRAINT automation_versions_automation_id_n_pk PRIMARY KEY (automation_id, n);
--> statement-breakpoint
ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_files
    ADD CONSTRAINT backup_files_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_key_state
    ADD CONSTRAINT backup_key_state_pkey PRIMARY KEY (appliance);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_passkey_keys
    ADD CONSTRAINT backup_passkey_keys_appliance_credential_id_pk PRIMARY KEY (appliance, credential_id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_places
    ADD CONSTRAINT backup_places_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_restore_map
    ADD CONSTRAINT backup_restore_map_pk PRIMARY KEY (burrow_id, source_burrow_id, source_id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_restores
    ADD CONSTRAINT backup_restores_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_uploads
    ADD CONSTRAINT backup_uploads_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.box_backup
    ADD CONSTRAINT box_backup_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.box_network
    ADD CONSTRAINT box_network_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.burrows
    ADD CONSTRAINT burrows_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.burrows
    ADD CONSTRAINT burrows_slug_unique UNIQUE (slug);
--> statement-breakpoint
ALTER TABLE ONLY public.canvas_comments
    ADD CONSTRAINT canvas_comments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.canvas_updates
    ADD CONSTRAINT canvas_updates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.canvases
    ADD CONSTRAINT canvases_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.catalog_connections
    ADD CONSTRAINT catalog_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.changes
    ADD CONSTRAINT changes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.chat_thread_runtimes
    ADD CONSTRAINT chat_thread_runtimes_pkey PRIMARY KEY (root_id);
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_actions
    ADD CONSTRAINT check_server_actions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_asks
    ADD CONSTRAINT check_server_asks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_clients
    ADD CONSTRAINT check_server_clients_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_computers
    ADD CONSTRAINT check_server_computers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.check_servers
    ADD CONSTRAINT check_servers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.command_allowances
    ADD CONSTRAINT command_allowances_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.command_passes
    ADD CONSTRAINT command_passes_pkey PRIMARY KEY (approval_id);
--> statement-breakpoint
ALTER TABLE ONLY public.command_receipts
    ADD CONSTRAINT command_receipts_principal_id_op_request_id_pk PRIMARY KEY (principal_id, op, request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_clients
    ADD CONSTRAINT connection_clients_issuer_unique UNIQUE (issuer);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_clients
    ADD CONSTRAINT connection_clients_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_events
    ADD CONSTRAINT connection_events_pk PRIMARY KEY (connection_id, event_id);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_found_state
    ADD CONSTRAINT connection_found_state_pkey PRIMARY KEY (burrow_id);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_pending
    ADD CONSTRAINT connection_pending_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.connection_points
    ADD CONSTRAINT connection_points_pk PRIMARY KEY (connection_id, key, at);
--> statement-breakpoint
ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.connector_apps
    ADD CONSTRAINT connector_apps_pkey PRIMARY KEY (provider);
--> statement-breakpoint
ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.council_members
    ADD CONSTRAINT council_members_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.council_setups
    ADD CONSTRAINT council_setups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_pk PRIMARY KEY (council_id, view);
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_pk PRIMARY KEY (task_id, view);
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_tasks
    ADD CONSTRAINT delegation_tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.desk_display
    ADD CONSTRAINT desk_display_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.desk_screens
    ADD CONSTRAINT desk_screens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.device_skills
    ADD CONSTRAINT device_skills_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.diagnostic_bundles
    ADD CONSTRAINT diagnostic_bundles_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.dispatches
    ADD CONSTRAINT dispatches_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.dispatches
    ADD CONSTRAINT dispatches_token_hash_unique UNIQUE (token_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.endpoint_device_links
    ADD CONSTRAINT endpoint_device_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.endpoint_device_links
    ADD CONSTRAINT endpoint_device_links_secret_hash_unique UNIQUE (secret_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.endpoint_pairings
    ADD CONSTRAINT endpoint_pairings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feature_requests
    ADD CONSTRAINT feature_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_assessments
    ADD CONSTRAINT feedback_assessments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_drop_expired
    ADD CONSTRAINT feedback_drop_expired_site_id_day_pk PRIMARY KEY (site_id, day);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_drop_keys
    ADD CONSTRAINT feedback_drop_keys_pkey PRIMARY KEY (kid);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_drop_outcomes
    ADD CONSTRAINT feedback_drop_outcomes_pkey PRIMARY KEY (drop_id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_drop_sites
    ADD CONSTRAINT feedback_drop_sites_pkey PRIMARY KEY (site_id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_drop_state
    ADD CONSTRAINT feedback_drop_state_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_integrations
    ADD CONSTRAINT feedback_integrations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_reports
    ADD CONSTRAINT feedback_reports_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.gateway_usage
    ADD CONSTRAINT gateway_usage_pkey PRIMARY KEY (connection_id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_branch_heads
    ADD CONSTRAINT github_branch_heads_burrow_id_repo_branch_pk PRIMARY KEY (burrow_id, repo, branch);
--> statement-breakpoint
ALTER TABLE ONLY public.github_connections
    ADD CONSTRAINT github_connections_pkey PRIMARY KEY (burrow_id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_deploys
    ADD CONSTRAINT github_deploys_pkey PRIMARY KEY (approval_id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_identities
    ADD CONSTRAINT github_identities_burrow_id_login_pk PRIMARY KEY (burrow_id, login);
--> statement-breakpoint
ALTER TABLE ONLY public.github_issues
    ADD CONSTRAINT github_issues_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_poll_cursors
    ADD CONSTRAINT github_poll_cursors_burrow_id_repo_pk PRIMARY KEY (burrow_id, repo);
--> statement-breakpoint
ALTER TABLE ONLY public.github_push_grants
    ADD CONSTRAINT github_push_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_seen
    ADD CONSTRAINT github_seen_burrow_id_repo_key_pk PRIMARY KEY (burrow_id, repo, key);
--> statement-breakpoint
ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_agent_id_key_id_pk PRIMARY KEY (agent_id, key_id);
--> statement-breakpoint
ALTER TABLE ONLY public.hermes_session_drops
    ADD CONSTRAINT hermes_session_drops_pk PRIMARY KEY (home, session_id);
--> statement-breakpoint
ALTER TABLE ONLY public.kept_sites
    ADD CONSTRAINT kept_sites_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.link_previews
    ADD CONSTRAINT link_previews_burrow_id_url_pk PRIMARY KEY (burrow_id, url);
--> statement-breakpoint
ALTER TABLE ONLY public.live_activities
    ADD CONSTRAINT live_activities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.merge_intents
    ADD CONSTRAINT merge_intents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.needs_you_snoozes
    ADD CONSTRAINT needs_you_snoozes_pk PRIMARY KEY (person_id, ref_kind, ref_id);
--> statement-breakpoint
ALTER TABLE ONLY public.notice_quiets
    ADD CONSTRAINT notice_quiets_pk PRIMARY KEY (owner_id, thing_id, check_id, subject);
--> statement-breakpoint
ALTER TABLE ONLY public.notice_states
    ADD CONSTRAINT notice_states_pk PRIMARY KEY (thing_id, check_id, subject);
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.personal_schedules
    ADD CONSTRAINT personal_schedules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_checks
    ADD CONSTRAINT pr_checks_pr_id_name_pk PRIMARY KEY (pr_id, name);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_commits
    ADD CONSTRAINT pr_commits_pr_id_sha_pk PRIMARY KEY (pr_id, sha);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_files
    ADD CONSTRAINT pr_files_pr_id_path_pk PRIMARY KEY (pr_id, path);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_reviewers
    ADD CONSTRAINT pr_reviewers_pr_id_principal_id_pk PRIMARY KEY (pr_id, principal_id);
--> statement-breakpoint
ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_value_principal_id_pk PRIMARY KEY (message_id, value, principal_id);
--> statement-breakpoint
ALTER TABLE ONLY public.read_states
    ADD CONSTRAINT read_states_conversation_id_principal_id_pk PRIMARY KEY (conversation_id, principal_id);
--> statement-breakpoint
ALTER TABLE ONLY public.repo_night_runs
    ADD CONSTRAINT repo_night_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.repo_places
    ADD CONSTRAINT repo_places_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.repo_rules
    ADD CONSTRAINT repo_rules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.repo_setups
    ADD CONSTRAINT repo_setups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.repos
    ADD CONSTRAINT repos_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_files
    ADD CONSTRAINT run_files_run_id_path_pk PRIMARY KEY (run_id, path);
--> statement-breakpoint
ALTER TABLE ONLY public.run_log
    ADD CONSTRAINT run_log_run_id_seq_pk PRIMARY KEY (run_id, seq);
--> statement-breakpoint
ALTER TABLE ONLY public.run_steps
    ADD CONSTRAINT run_steps_run_id_idx_pk PRIMARY KEY (run_id, idx);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.search_answers
    ADD CONSTRAINT search_answers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.search_documents
    ADD CONSTRAINT search_documents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.server_asks
    ADD CONSTRAINT server_asks_pk PRIMARY KEY (burrow_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.server_cares
    ADD CONSTRAINT server_cares_pk PRIMARY KEY (burrow_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.server_names
    ADD CONSTRAINT server_names_pk PRIMARY KEY (burrow_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.server_runner_facts
    ADD CONSTRAINT server_runner_facts_pkey PRIMARY KEY (server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.session_events
    ADD CONSTRAINT session_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.session_uploads
    ADD CONSTRAINT session_uploads_pkey PRIMARY KEY (attachment_id);
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.subscription_usage
    ADD CONSTRAINT subscription_usage_account_id_provider_pk PRIMARY KEY (account_id, provider);
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_pk PRIMARY KEY (connection_id, thread_id);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_places
    ADD CONSTRAINT thread_places_pkey PRIMARY KEY (root_id);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_root_id_principal_id_pk PRIMARY KEY (root_id, principal_id);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_cursors
    ADD CONSTRAINT tracker_cursors_pkey PRIMARY KEY (connection_id);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_fixes
    ADD CONSTRAINT tracker_fixes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_grants
    ADD CONSTRAINT tracker_grants_run_id_step_id_attempt_pk PRIMARY KEY (run_id, step_id, attempt);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_items
    ADD CONSTRAINT tracker_items_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_replies
    ADD CONSTRAINT tracker_replies_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_updates
    ADD CONSTRAINT tracker_updates_pkey PRIMARY KEY (request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.upload_reservations
    ADD CONSTRAINT upload_reservations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_entries
    ADD CONSTRAINT vault_entries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_networks
    ADD CONSTRAINT vault_networks_cidr_unique UNIQUE (cidr);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_networks
    ADD CONSTRAINT vault_networks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_ssh_servers
    ADD CONSTRAINT vault_ssh_servers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_uses
    ADD CONSTRAINT vault_uses_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.voice_typing
    ADD CONSTRAINT voice_typing_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.watch_offs
    ADD CONSTRAINT watch_offs_pk PRIMARY KEY (owner_id, thing_id, check_id, subject);
--> statement-breakpoint
ALTER TABLE ONLY public.watch_ons
    ADD CONSTRAINT watch_ons_pk PRIMARY KEY (owner_id, thing_id, check_id);
--> statement-breakpoint
ALTER TABLE ONLY public.widget_points
    ADD CONSTRAINT widget_points_pk PRIMARY KEY (widget_id, t);
--> statement-breakpoint
ALTER TABLE ONLY public.widgets
    ADD CONSTRAINT widgets_pkey PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX activities_conversation_idx ON public.activities USING btree (conversation_id, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX activities_dispatch_key_idx ON public.activities USING btree (dispatch_id, key);
--> statement-breakpoint
CREATE INDEX activities_dispatch_rev_idx ON public.activities USING btree (dispatch_id, rev);
--> statement-breakpoint
CREATE INDEX activities_open_idx ON public.activities USING btree (status) WHERE (status = ANY (ARRAY['running'::text, 'waiting'::text]));
--> statement-breakpoint
CREATE INDEX activities_run_rev_idx ON public.activities USING btree (run_id, rev);
--> statement-breakpoint
CREATE INDEX agent_schedules_agent_idx ON public.agent_schedules USING btree (agent_id, status);
--> statement-breakpoint
CREATE INDEX agent_schedules_due_idx ON public.agent_schedules USING btree (next_at) WHERE (status = 'active'::text);
--> statement-breakpoint
CREATE INDEX agent_schedules_for_idx ON public.agent_schedules USING btree (burrow_id, for_account_id) WHERE (status <> 'ended'::text);
--> statement-breakpoint
CREATE INDEX appliance_claim_attempts_at_idx ON public.appliance_claim_attempts USING btree (at);
--> statement-breakpoint
CREATE INDEX appliance_claim_failures_at_idx ON public.appliance_claim_failures USING btree (at);
--> statement-breakpoint
CREATE INDEX appliance_endpoints_account_idx ON public.appliance_endpoints USING btree (account_id);
--> statement-breakpoint
CREATE INDEX appliance_passkeys_account_idx ON public.appliance_passkeys USING btree (account_id);
--> statement-breakpoint
CREATE INDEX approvals_execute_at_idx ON public.approvals USING btree (execute_at) WHERE ((execute_at IS NOT NULL) AND (executed_at IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX approvals_number_idx ON public.approvals USING btree (burrow_id, number);
--> statement-breakpoint
CREATE INDEX approvals_state_idx ON public.approvals USING btree (burrow_id, state);
--> statement-breakpoint
CREATE INDEX assistant_states_account_idx ON public.assistant_states USING btree (account_id);
--> statement-breakpoint
CREATE INDEX attachments_burrow_state_idx ON public.attachments USING btree (burrow_id, state);
--> statement-breakpoint
CREATE INDEX attachments_conversation_state_idx ON public.attachments USING btree (conversation_id, state);
--> statement-breakpoint
CREATE INDEX attachments_message_idx ON public.attachments USING btree (message_id);
--> statement-breakpoint
CREATE INDEX attachments_orphans_idx ON public.attachments USING btree (state, created_at);
--> statement-breakpoint
CREATE INDEX attachments_sha256_idx ON public.attachments USING btree (sha256);
--> statement-breakpoint
CREATE INDEX attachments_uploader_idx ON public.attachments USING btree (uploaded_by_id, created_at);
--> statement-breakpoint
CREATE INDEX automation_plans_automation_idx ON public.automation_plans USING btree (automation_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_plans_waiting_idx ON public.automation_plans USING btree (automation_id) WHERE (status = 'waiting'::text);
--> statement-breakpoint
CREATE INDEX automation_run_steps_approval_idx ON public.automation_run_steps USING btree (approval_id);
--> statement-breakpoint
CREATE INDEX automation_run_steps_dispatch_idx ON public.automation_run_steps USING btree (dispatch_id);
--> statement-breakpoint
CREATE INDEX automation_runs_automation_idx ON public.automation_runs USING btree (automation_id, created_at);
--> statement-breakpoint
CREATE INDEX automation_runs_item_idx ON public.automation_runs USING btree (automation_id, item_key, created_at) WHERE (item_key IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_runs_number_idx ON public.automation_runs USING btree (burrow_id, number);
--> statement-breakpoint
CREATE INDEX automation_runs_status_idx ON public.automation_runs USING btree (status);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_runs_trigger_idx ON public.automation_runs USING btree (automation_id, version, trigger_key);
--> statement-breakpoint
CREATE INDEX automations_burrow_idx ON public.automations USING btree (burrow_id, status);
--> statement-breakpoint
CREATE INDEX automations_fire_idx ON public.automations USING btree (next_fire_at);
--> statement-breakpoint
CREATE INDEX backup_files_burrow_idx ON public.backup_files USING btree (burrow_id, created_at);
--> statement-breakpoint
CREATE INDEX backup_restores_burrow_idx ON public.backup_restores USING btree (burrow_id, started_at);
--> statement-breakpoint
CREATE UNIQUE INDEX backup_restores_one_running ON public.backup_restores USING btree (burrow_id) WHERE (status = 'restoring'::text);
--> statement-breakpoint
CREATE INDEX backup_uploads_burrow_idx ON public.backup_uploads USING btree (burrow_id, uploaded_by_id);
--> statement-breakpoint
CREATE UNIQUE INDEX briefs_person_day_idx ON public.briefs USING btree (burrow_id, person_id, kind, day);
--> statement-breakpoint
CREATE INDEX briefs_writing_idx ON public.briefs USING btree (created_at) WHERE (state = 'writing'::text);
--> statement-breakpoint
CREATE INDEX canvas_comments_canvas_idx ON public.canvas_comments USING btree (canvas_id, created_at);
--> statement-breakpoint
CREATE INDEX canvas_updates_canvas_idx ON public.canvas_updates USING btree (canvas_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX canvases_slug_idx ON public.canvases USING btree (burrow_id, slug);
--> statement-breakpoint
CREATE INDEX catalog_connections_burrow_idx ON public.catalog_connections USING btree (burrow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX catalog_connections_handle_idx ON public.catalog_connections USING btree (burrow_id, handle);
--> statement-breakpoint
CREATE INDEX changes_burrow_idx ON public.changes USING btree (burrow_id, created_at);
--> statement-breakpoint
CREATE INDEX changes_subject_idx ON public.changes USING btree (burrow_id, subject_kind, subject_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_actions_key_idx ON public.check_server_actions USING btree (check_server_id, key);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_actions_repo_idx ON public.check_server_actions USING btree (burrow_id, lower(repo));
--> statement-breakpoint
CREATE INDEX check_server_actions_server_idx ON public.check_server_actions USING btree (check_server_id);
--> statement-breakpoint
CREATE INDEX check_server_asks_burrow_idx ON public.check_server_asks USING btree (burrow_id, server_id);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_asks_message_idx ON public.check_server_asks USING btree (message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_clients_unique ON public.check_server_clients USING btree (check_server_id, server_id);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_computers_name_idx ON public.check_server_computers USING btree (check_server_id, lower(name));
--> statement-breakpoint
CREATE INDEX check_server_computers_server_idx ON public.check_server_computers USING btree (check_server_id);
--> statement-breakpoint
CREATE UNIQUE INDEX check_server_computers_slug_idx ON public.check_server_computers USING btree (check_server_id, slug);
--> statement-breakpoint
CREATE INDEX check_servers_burrow_idx ON public.check_servers USING btree (burrow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX command_allowances_match_idx ON public.command_allowances USING btree (agent_id, key_id, command, target);
--> statement-breakpoint
CREATE INDEX command_passes_agent_idx ON public.command_passes USING btree (agent_id, command);
--> statement-breakpoint
CREATE INDEX command_receipts_created_idx ON public.command_receipts USING btree (created_at);
--> statement-breakpoint
CREATE INDEX connection_events_at_idx ON public.connection_events USING btree (at);
--> statement-breakpoint
CREATE INDEX connection_events_recent_idx ON public.connection_events USING btree (connection_id, at);
--> statement-breakpoint
CREATE UNIQUE INDEX connection_found_hidden_pk ON public.connection_found_hidden USING btree (burrow_id, catalog_id, host, port);
--> statement-breakpoint
CREATE INDEX connection_pending_account_idx ON public.connection_pending USING btree (account_id);
--> statement-breakpoint
CREATE INDEX connection_points_at_idx ON public.connection_points USING btree (at);
--> statement-breakpoint
CREATE UNIQUE INDEX connection_tools_pk ON public.connection_tools USING btree (connection_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX connections_account_provider_idx ON public.connections USING btree (account_id, provider);
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_dm_idx ON public.conversations USING btree (dm_agent_id, dm_person_id) WHERE ((kind = 'dm'::text) AND (task_key IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_slug_idx ON public.conversations USING btree (burrow_id, kind, slug) WHERE (task_key IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_task_idx ON public.conversations USING btree (dm_agent_id, dm_person_id, task_key) WHERE (task_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX council_members_round_idx ON public.council_members USING btree (council_id, stage, round);
--> statement-breakpoint
CREATE INDEX council_members_thread_idx ON public.council_members USING btree (thread_id);
--> statement-breakpoint
CREATE INDEX council_setups_burrow_idx ON public.council_setups USING btree (burrow_id, "position");
--> statement-breakpoint
CREATE INDEX councils_active_idx ON public.councils USING btree (burrow_id, state);
--> statement-breakpoint
CREATE INDEX councils_thread_idx ON public.councils USING btree (conversation_id, thread_root_id);
--> statement-breakpoint
CREATE INDEX councils_upload_idx ON public.councils USING btree (upload_hash);
--> statement-breakpoint
CREATE INDEX delegation_shots_delegation_idx ON public.delegation_shots USING btree (delegation_id);
--> statement-breakpoint
CREATE INDEX delegation_tasks_delegation_idx ON public.delegation_tasks USING btree (delegation_id, "position");
--> statement-breakpoint
CREATE INDEX delegation_tasks_dispatch_idx ON public.delegation_tasks USING btree (dispatch_id);
--> statement-breakpoint
CREATE INDEX delegation_tasks_thread_idx ON public.delegation_tasks USING btree (thread_id);
--> statement-breakpoint
CREATE INDEX delegation_tasks_upload_idx ON public.delegation_tasks USING btree (upload_hash);
--> statement-breakpoint
CREATE INDEX delegations_stage_idx ON public.delegations USING btree (burrow_id, stage);
--> statement-breakpoint
CREATE INDEX delegations_thread_idx ON public.delegations USING btree (conversation_id, thread_root_id);
--> statement-breakpoint
CREATE UNIQUE INDEX deployments_approval_idx ON public.deployments USING btree (approval_id) WHERE (approval_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX deployments_burrow_idx ON public.deployments USING btree (burrow_id, created_at, id);
--> statement-breakpoint
CREATE INDEX deployments_service_idx ON public.deployments USING btree (burrow_id, environment_key, service_key, created_at);
--> statement-breakpoint
CREATE INDEX device_skills_burrow_idx ON public.device_skills USING btree (burrow_id, status);
--> statement-breakpoint
CREATE INDEX device_skills_connection_idx ON public.device_skills USING btree (connection_id);
--> statement-breakpoint
CREATE UNIQUE INDEX devices_token_idx ON public.devices USING btree (account_id, token);
--> statement-breakpoint
CREATE INDEX dispatches_agent_idx ON public.dispatches USING btree (agent_id, conversation_id, state);
--> statement-breakpoint
CREATE INDEX dispatches_approval_idx ON public.dispatches USING btree (approval_id) WHERE (approval_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX dispatches_finished_idx ON public.dispatches USING btree (burrow_id, finished_at);
--> statement-breakpoint
CREATE INDEX dispatches_plan_idx ON public.dispatches USING btree (plan_id) WHERE (plan_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX dispatches_plan_step_idx ON public.dispatches USING btree (plan_step_id) WHERE (plan_step_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX dispatches_queue_idx ON public.dispatches USING btree (state, created_at);
--> statement-breakpoint
CREATE INDEX dispatches_run_idx ON public.dispatches USING btree (run_id);
--> statement-breakpoint
CREATE INDEX dispatches_schedule_idx ON public.dispatches USING btree (schedule_id) WHERE (schedule_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX dispatches_thread_idx ON public.dispatches USING btree (conversation_id, thread_root_id, created_at) WHERE (thread_root_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX done_tasks_burrow_idx ON public.done_tasks USING btree (burrow_id, reported_at);
--> statement-breakpoint
CREATE UNIQUE INDEX done_tasks_thread_idx ON public.done_tasks USING btree (conversation_id, COALESCE(thread_root_id, ''::text));
--> statement-breakpoint
CREATE INDEX endpoint_device_links_account_idx ON public.endpoint_device_links USING btree (account_id);
--> statement-breakpoint
CREATE INDEX endpoint_pairings_peer_idx ON public.endpoint_pairings USING btree (peer_id);
--> statement-breakpoint
CREATE UNIQUE INDEX endpoint_pairings_pending_code_idx ON public.endpoint_pairings USING btree (code) WHERE (state = 'pending'::text);
--> statement-breakpoint
CREATE INDEX events_about_idx ON public.events USING btree (burrow_id, about_id);
--> statement-breakpoint
CREATE INDEX events_actor_idx ON public.events USING btree (burrow_id, actor_id);
--> statement-breakpoint
CREATE INDEX events_agent_brief_idx ON public.events USING btree (burrow_id, ((payload ->> 'messageId'::text))) WHERE (type = 'message.agent_brief'::text);
--> statement-breakpoint
CREATE INDEX events_approval_idx ON public.events USING btree (approval_id);
--> statement-breakpoint
CREATE UNIQUE INDEX events_chain_idx ON public.events USING btree (burrow_id, seq);
--> statement-breakpoint
CREATE INDEX events_listed_kind_idx ON public.events USING btree (burrow_id, kind) INCLUDE (actor_id, about_id) WHERE (text IS NOT NULL);
--> statement-breakpoint
CREATE INDEX feature_requests_report_idx ON public.feature_requests USING btree (connection_id, report_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX feature_requests_step_idx ON public.feature_requests USING btree (run_id, step_id, attempt);
--> statement-breakpoint
CREATE INDEX feature_requests_waiting_idx ON public.feature_requests USING btree (burrow_id) WHERE (state = 'waiting'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_assessments_attempt_idx ON public.feedback_assessments USING btree (report_id, attempt);
--> statement-breakpoint
CREATE INDEX feedback_assessments_budget_idx ON public.feedback_assessments USING btree (integration_id, started_at);
--> statement-breakpoint
CREATE INDEX feedback_assessments_dispatch_idx ON public.feedback_assessments USING btree (dispatch_id);
--> statement-breakpoint
CREATE INDEX feedback_drop_outcomes_at_idx ON public.feedback_drop_outcomes USING btree (at);
--> statement-breakpoint
CREATE INDEX feedback_drop_outcomes_integration_idx ON public.feedback_drop_outcomes USING btree (integration_id, at);
--> statement-breakpoint
CREATE INDEX feedback_integrations_burrow_idx ON public.feedback_integrations USING btree (burrow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_integrations_site_idx ON public.feedback_integrations USING btree (site_id);
--> statement-breakpoint
CREATE INDEX feedback_reports_assessment_idx ON public.feedback_reports USING btree (assessment_state, assessment_not_before);
--> statement-breakpoint
CREATE INDEX feedback_reports_dispatch_idx ON public.feedback_reports USING btree (assessment_dispatch_id);
--> statement-breakpoint
CREATE INDEX feedback_reports_integration_idx ON public.feedback_reports USING btree (integration_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_reports_reference_idx ON public.feedback_reports USING btree (reference);
--> statement-breakpoint
CREATE INDEX feedback_reports_reporter_dirty_idx ON public.feedback_reports USING btree (id) WHERE reporter_dirty;
--> statement-breakpoint
CREATE INDEX feedback_reports_reporter_idx ON public.feedback_reports USING btree (integration_id, reporter_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_reports_root_idx ON public.feedback_reports USING btree (root_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_reports_submission_idx ON public.feedback_reports USING btree (integration_id, submission_id);
--> statement-breakpoint
CREATE INDEX followed_tasks_approval_idx ON public.followed_tasks USING btree (approval_id) WHERE (approval_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX followed_tasks_dispatch_idx ON public.followed_tasks USING btree (dispatch_id) WHERE (dispatch_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX followed_tasks_ended_idx ON public.followed_tasks USING btree (ended_at) WHERE (ended_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX followed_tasks_running_idx ON public.followed_tasks USING btree (started_at) WHERE (state = 'running'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX followed_tasks_task_idx ON public.followed_tasks USING btree (server_id, task_id);
--> statement-breakpoint
CREATE INDEX gateway_usage_burrow_idx ON public.gateway_usage USING btree (burrow_id);
--> statement-breakpoint
CREATE INDEX github_deploys_open_idx ON public.github_deploys USING btree (repo, workflow) WHERE (state = ANY (ARRAY['dispatched'::text, 'running'::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX github_identities_principal_idx ON public.github_identities USING btree (burrow_id, principal_id);
--> statement-breakpoint
CREATE UNIQUE INDEX github_issues_number_idx ON public.github_issues USING btree (burrow_id, repo, number);
--> statement-breakpoint
CREATE INDEX github_push_grants_branch_idx ON public.github_push_grants USING btree (burrow_id, repo, branch);
--> statement-breakpoint
CREATE INDEX hermes_session_drops_handed_idx ON public.hermes_session_drops USING btree (handed_at);
--> statement-breakpoint
CREATE INDEX kept_sites_burrow_idx ON public.kept_sites USING btree (burrow_id, expires_at);
--> statement-breakpoint
CREATE INDEX kept_sites_expires_idx ON public.kept_sites USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX link_previews_fetched_idx ON public.link_previews USING btree (fetched_at);
--> statement-breakpoint
CREATE UNIQUE INDEX live_activities_ref_idx ON public.live_activities USING btree (device_id, kind, ref_id);
--> statement-breakpoint
CREATE INDEX look_researches_burrow_idx ON public.look_researches USING btree (burrow_id, started_at);
--> statement-breakpoint
CREATE INDEX look_researches_dispatch_idx ON public.look_researches USING btree (dispatch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX look_researches_live_idx ON public.look_researches USING btree (burrow_id, look_key) WHERE (gone_at IS NULL);
--> statement-breakpoint
CREATE INDEX look_researches_thread_idx ON public.look_researches USING btree (thread_root_id);
--> statement-breakpoint
CREATE UNIQUE INDEX merge_intents_active_pr_idx ON public.merge_intents USING btree (pr_id) WHERE (state = ANY (ARRAY['pending'::text, 'running'::text, 'unknown'::text]));
--> statement-breakpoint
CREATE INDEX merge_intents_state_idx ON public.merge_intents USING btree (state);
--> statement-breakpoint
CREATE INDEX messages_asks_idx ON public.messages USING btree (author_id) WHERE asks;
--> statement-breakpoint
CREATE UNIQUE INDEX messages_client_id_idx ON public.messages USING btree (conversation_id, author_id, client_id) WHERE (client_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX messages_conversation_idx ON public.messages USING btree (conversation_id, created_at, ord);
--> statement-breakpoint
CREATE INDEX messages_dispatch_idx ON public.messages USING btree (dispatch_id) WHERE (dispatch_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX messages_open_guides_idx ON public.messages USING btree (conversation_id, created_at) WHERE (((card ->> 'kind'::text) = 'guide'::text) AND ((card ->> 'state'::text) = 'open'::text));
--> statement-breakpoint
CREATE INDEX messages_pins_idx ON public.messages USING btree (conversation_id, pinned_at) WHERE (pinned_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX messages_settle_candidates_idx ON public.messages USING btree (conversation_id, COALESCE(last_reply_at, created_at)) WHERE ((thread_root_id IS NULL) AND (settled_at IS NULL) AND (kept_open_at IS NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX messages_settled_idx ON public.messages USING btree (conversation_id, settled_at DESC, id DESC) WHERE ((thread_root_id IS NULL) AND (settled_at IS NOT NULL));
--> statement-breakpoint
CREATE INDEX messages_subject_idx ON public.messages USING btree (conversation_id, subject_kind, subject_id) WHERE (subject_kind IS NOT NULL);
--> statement-breakpoint
CREATE INDEX messages_thread_activity_idx ON public.messages USING btree (conversation_id, COALESCE(last_reply_at, created_at) DESC, id DESC) WHERE (thread_root_id IS NULL);
--> statement-breakpoint
CREATE INDEX messages_thread_idx ON public.messages USING btree (thread_root_id, created_at, ord);
--> statement-breakpoint
CREATE INDEX messages_top_level_idx ON public.messages USING btree (conversation_id, ord) INCLUDE (author_id, mentions, deleted_at) WHERE (thread_root_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX notifications_dedup_idx ON public.notifications USING btree (principal_id, dedup_key) WHERE (dedup_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX notifications_email_idx ON public.notifications USING btree (created_at) WHERE ((read_at IS NULL) AND (emailed_at IS NULL));
--> statement-breakpoint
CREATE INDEX notifications_principal_idx ON public.notifications USING btree (principal_id, created_at);
--> statement-breakpoint
CREATE INDEX oauth_states_account_idx ON public.oauth_states USING btree (account_id);
--> statement-breakpoint
CREATE INDEX outbox_unpublished_idx ON public.outbox USING btree (published_at, id);
--> statement-breakpoint
CREATE INDEX personal_schedules_due_idx ON public.personal_schedules USING btree (next_run_at) WHERE enabled;
--> statement-breakpoint
CREATE UNIQUE INDEX personal_schedules_person_kind_idx ON public.personal_schedules USING btree (burrow_id, person_id, kind);
--> statement-breakpoint
CREATE INDEX plans_conversation_idx ON public.plans USING btree (conversation_id, updated_at);
--> statement-breakpoint
CREATE INDEX plans_steps_idx ON public.plans USING gin (steps jsonb_path_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX principals_account_idx ON public.principals USING btree (burrow_id, account_id) WHERE (account_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX principals_account_lookup_idx ON public.principals USING btree (account_id);
--> statement-breakpoint
CREATE UNIQUE INDEX principals_agent_idx ON public.principals USING btree (burrow_id) WHERE (kind = 'agent'::text);
--> statement-breakpoint
CREATE INDEX principals_avatar_idx ON public.principals USING btree (avatar_attachment_id) WHERE (avatar_attachment_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX principals_handle_idx ON public.principals USING btree (burrow_id, handle);
--> statement-breakpoint
CREATE INDEX prompts_burrow_idx ON public.prompts USING btree (burrow_id, "position");
--> statement-breakpoint
CREATE UNIQUE INDEX prompts_starter_idx ON public.prompts USING btree (burrow_id, starter_key) WHERE (starter_key IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX pull_requests_number_idx ON public.pull_requests USING btree (repo_id, number);
--> statement-breakpoint
CREATE UNIQUE INDEX repo_night_runs_one_running ON public.repo_night_runs USING btree (place_id, repo) WHERE (state = 'running'::text);
--> statement-breakpoint
CREATE INDEX repo_night_runs_repo_idx ON public.repo_night_runs USING btree (place_id, repo, started_at);
--> statement-breakpoint
CREATE INDEX repo_places_burrow_idx ON public.repo_places USING btree (burrow_id);
--> statement-breakpoint
CREATE INDEX repo_rules_path_idx ON public.repo_rules USING btree (burrow_id, path);
--> statement-breakpoint
CREATE UNIQUE INDEX repo_rules_place_repo_idx ON public.repo_rules USING btree (place_id, repo);
--> statement-breakpoint
CREATE INDEX repo_setups_burrow_idx ON public.repo_setups USING btree (burrow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX repo_setups_one_going ON public.repo_setups USING btree (place_id, repo) WHERE (state <> 'stopped'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX repos_name_idx ON public.repos USING btree (burrow_id, full_name);
--> statement-breakpoint
CREATE INDEX runs_agent_idx ON public.runs USING btree (agent_id, started_at);
--> statement-breakpoint
CREATE INDEX runs_dispatch_idx ON public.runs USING btree (dispatch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX runs_number_idx ON public.runs USING btree (burrow_id, number);
--> statement-breakpoint
CREATE UNIQUE INDEX screens_endpoint_idx ON public.screens USING btree (endpoint_id);
--> statement-breakpoint
CREATE INDEX search_answers_query_idx ON public.search_answers USING btree (burrow_id, asked_by_id, query);
--> statement-breakpoint
CREATE INDEX search_documents_burrow_idx ON public.search_documents USING btree (burrow_id, type);
--> statement-breakpoint
CREATE INDEX search_documents_conversation_idx ON public.search_documents USING btree (burrow_id, conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX search_documents_tsv_idx ON public.search_documents USING gin (tsv);
--> statement-breakpoint
CREATE UNIQUE INDEX server_names_name_uq ON public.server_names USING btree (burrow_id, lower(name));
--> statement-breakpoint
CREATE INDEX server_runner_facts_burrow_idx ON public.server_runner_facts USING btree (burrow_id);
--> statement-breakpoint
CREATE INDEX session_events_created_idx ON public.session_events USING btree (created_at);
--> statement-breakpoint
CREATE INDEX session_events_topic_idx ON public.session_events USING btree (topic, id);
--> statement-breakpoint
CREATE INDEX shares_burrow_idx ON public.shares USING btree (burrow_id, created_at);
--> statement-breakpoint
CREATE INDEX shares_root_idx ON public.shares USING btree (root_id);
--> statement-breakpoint
CREATE INDEX t3_watches_conversation_idx ON public.t3_watches USING btree (conversation_id);
--> statement-breakpoint
CREATE INDEX t3_watches_dispatch_idx ON public.t3_watches USING btree (dispatch_id) WHERE (dispatch_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX t3_watches_watching_idx ON public.t3_watches USING btree (armed_at) WHERE (state = 'watching'::text);
--> statement-breakpoint
CREATE INDEX thread_places_conversation_idx ON public.thread_places USING btree (conversation_id, place);
--> statement-breakpoint
CREATE INDEX tracker_fixes_followed_idx ON public.tracker_fixes USING btree (burrow_id) WHERE (state = ANY (ARRAY['open'::text, 'merged'::text, 'development'::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX tracker_fixes_pr_idx ON public.tracker_fixes USING btree (connection_id, report_id, repo, pr_number);
--> statement-breakpoint
CREATE INDEX tracker_fixes_report_idx ON public.tracker_fixes USING btree (connection_id, report_id);
--> statement-breakpoint
CREATE INDEX tracker_grants_open_idx ON public.tracker_grants USING btree (connection_id) WHERE ((revoked_at IS NULL) AND (token_sealed IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX tracker_items_connection_idx ON public.tracker_items USING btree (connection_id, external_id);
--> statement-breakpoint
CREATE INDEX tracker_items_number_idx ON public.tracker_items USING btree (connection_id, number);
--> statement-breakpoint
CREATE INDEX upload_reservations_rate_idx ON public.upload_reservations USING btree (rate_key, created_at);
--> statement-breakpoint
CREATE INDEX vault_entries_owner_idx ON public.vault_entries USING btree (burrow_id, owner_id);
--> statement-breakpoint
CREATE INDEX vault_entries_tool_key_idx ON public.vault_entries USING btree (burrow_id, tool_key);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_ssh_servers_name_idx ON public.vault_ssh_servers USING btree (entry_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_tools_name_idx ON public.vault_tools USING btree (entry_id, name);
--> statement-breakpoint
CREATE INDEX vault_uses_entry_idx ON public.vault_uses USING btree (entry_id, at);
--> statement-breakpoint
CREATE INDEX vault_uses_event_idx ON public.vault_uses USING btree (event_id);
--> statement-breakpoint
CREATE INDEX widgets_owner_idx ON public.widgets USING btree (burrow_id, owner_id, "position");
--> statement-breakpoint
CREATE INDEX widgets_thing_idx ON public.widgets USING btree (owner_id, thing_id);
--> statement-breakpoint
CREATE TRIGGER appliance_events_no_truncate BEFORE TRUNCATE ON public.appliance_events FOR EACH STATEMENT EXECUTE FUNCTION public.events_append_only();
--> statement-breakpoint
CREATE TRIGGER appliance_events_no_update_or_delete BEFORE DELETE OR UPDATE ON public.appliance_events FOR EACH ROW EXECUTE FUNCTION public.events_append_only();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION public.events_append_only();
--> statement-breakpoint
CREATE TRIGGER events_no_update_or_delete BEFORE DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_append_only();
--> statement-breakpoint
ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_schedules
    ADD CONSTRAINT agent_schedules_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_schedules
    ADD CONSTRAINT agent_schedules_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_endpoints
    ADD CONSTRAINT appliance_endpoints_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.appliance_passkeys
    ADD CONSTRAINT appliance_passkeys_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_states
    ADD CONSTRAINT assistant_states_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_states
    ADD CONSTRAINT assistant_states_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_states
    ADD CONSTRAINT assistant_states_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.automation_cursors
    ADD CONSTRAINT automation_cursors_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_destinations
    ADD CONSTRAINT automation_destinations_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_plans
    ADD CONSTRAINT automation_plans_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.automation_plans
    ADD CONSTRAINT automation_plans_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.automation_run_steps
    ADD CONSTRAINT automation_run_steps_run_id_automation_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.automation_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_versions
    ADD CONSTRAINT automation_versions_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.backup_files
    ADD CONSTRAINT backup_files_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_files
    ADD CONSTRAINT backup_files_made_by_id_principals_id_fk FOREIGN KEY (made_by_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_passkey_keys
    ADD CONSTRAINT backup_passkey_keys_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_restore_map
    ADD CONSTRAINT backup_restore_map_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_restores
    ADD CONSTRAINT backup_restores_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_restores
    ADD CONSTRAINT backup_restores_restored_by_id_principals_id_fk FOREIGN KEY (restored_by_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_uploads
    ADD CONSTRAINT backup_uploads_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.backup_uploads
    ADD CONSTRAINT backup_uploads_uploaded_by_id_principals_id_fk FOREIGN KEY (uploaded_by_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.canvas_comments
    ADD CONSTRAINT canvas_comments_canvas_id_canvases_id_fk FOREIGN KEY (canvas_id) REFERENCES public.canvases(id);
--> statement-breakpoint
ALTER TABLE ONLY public.canvas_updates
    ADD CONSTRAINT canvas_updates_canvas_id_canvases_id_fk FOREIGN KEY (canvas_id) REFERENCES public.canvases(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.canvases
    ADD CONSTRAINT canvases_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.catalog_connections
    ADD CONSTRAINT catalog_connections_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.catalog_connections
    ADD CONSTRAINT catalog_connections_connected_by_id_principals_id_fk FOREIGN KEY (connected_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.changes
    ADD CONSTRAINT changes_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.chat_thread_runtimes
    ADD CONSTRAINT chat_thread_runtimes_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.chat_thread_runtimes
    ADD CONSTRAINT chat_thread_runtimes_root_id_messages_id_fk FOREIGN KEY (root_id) REFERENCES public.messages(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_actions
    ADD CONSTRAINT check_server_actions_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_actions
    ADD CONSTRAINT check_server_actions_check_server_id_check_servers_id_fk FOREIGN KEY (check_server_id) REFERENCES public.check_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_actions
    ADD CONSTRAINT check_server_actions_created_by_id_principals_id_fk FOREIGN KEY (created_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_asks
    ADD CONSTRAINT check_server_asks_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_asks
    ADD CONSTRAINT check_server_asks_created_by_id_principals_id_fk FOREIGN KEY (created_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_asks
    ADD CONSTRAINT check_server_asks_server_id_vault_ssh_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.vault_ssh_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_clients
    ADD CONSTRAINT check_server_clients_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_clients
    ADD CONSTRAINT check_server_clients_check_server_id_check_servers_id_fk FOREIGN KEY (check_server_id) REFERENCES public.check_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_clients
    ADD CONSTRAINT check_server_clients_server_id_vault_ssh_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.vault_ssh_servers(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_computers
    ADD CONSTRAINT check_server_computers_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_computers
    ADD CONSTRAINT check_server_computers_check_server_id_check_servers_id_fk FOREIGN KEY (check_server_id) REFERENCES public.check_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_server_computers
    ADD CONSTRAINT check_server_computers_created_by_id_principals_id_fk FOREIGN KEY (created_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.check_servers
    ADD CONSTRAINT check_servers_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.check_servers
    ADD CONSTRAINT check_servers_created_by_id_principals_id_fk FOREIGN KEY (created_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.check_servers
    ADD CONSTRAINT check_servers_server_id_vault_ssh_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.vault_ssh_servers(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY public.command_allowances
    ADD CONSTRAINT command_allowances_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.command_passes
    ADD CONSTRAINT command_passes_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_events
    ADD CONSTRAINT connection_events_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_found_hidden
    ADD CONSTRAINT connection_found_hidden_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_found_hidden
    ADD CONSTRAINT connection_found_hidden_hidden_by_principals_id_fk FOREIGN KEY (hidden_by) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_found_state
    ADD CONSTRAINT connection_found_state_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_pending
    ADD CONSTRAINT connection_pending_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_pending
    ADD CONSTRAINT connection_pending_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_pending
    ADD CONSTRAINT connection_pending_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_points
    ADD CONSTRAINT connection_points_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connection_tools
    ADD CONSTRAINT connection_tools_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.connector_apps
    ADD CONSTRAINT connector_apps_updated_by_account_id_accounts_id_fk FOREIGN KEY (updated_by_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.council_members
    ADD CONSTRAINT council_members_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.council_members
    ADD CONSTRAINT council_members_council_id_councils_id_fk FOREIGN KEY (council_id) REFERENCES public.councils(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.council_setups
    ADD CONSTRAINT council_setups_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_after_id_attachments_id_fk FOREIGN KEY (after_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_before_id_attachments_id_fk FOREIGN KEY (before_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_compare_id_attachments_id_fk FOREIGN KEY (compare_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.council_shots
    ADD CONSTRAINT council_shots_council_id_councils_id_fk FOREIGN KEY (council_id) REFERENCES public.councils(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.councils
    ADD CONSTRAINT councils_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_after_id_attachments_id_fk FOREIGN KEY (after_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_before_id_attachments_id_fk FOREIGN KEY (before_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_compare_id_attachments_id_fk FOREIGN KEY (compare_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_delegation_id_delegations_id_fk FOREIGN KEY (delegation_id) REFERENCES public.delegations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_shots
    ADD CONSTRAINT delegation_shots_task_id_delegation_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.delegation_tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_tasks
    ADD CONSTRAINT delegation_tasks_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegation_tasks
    ADD CONSTRAINT delegation_tasks_delegation_id_delegations_id_fk FOREIGN KEY (delegation_id) REFERENCES public.delegations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_council_id_councils_id_fk FOREIGN KEY (council_id) REFERENCES public.councils(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.desk_screens
    ADD CONSTRAINT desk_screens_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.desk_screens
    ADD CONSTRAINT desk_screens_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.device_skills
    ADD CONSTRAINT device_skills_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.device_skills
    ADD CONSTRAINT device_skills_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.device_skills
    ADD CONSTRAINT device_skills_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.device_skills
    ADD CONSTRAINT device_skills_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.dispatches
    ADD CONSTRAINT dispatches_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.done_tasks
    ADD CONSTRAINT done_tasks_thread_root_id_messages_id_fk FOREIGN KEY (thread_root_id) REFERENCES public.messages(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.endpoint_device_links
    ADD CONSTRAINT endpoint_device_links_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.feature_requests
    ADD CONSTRAINT feature_requests_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.feature_requests
    ADD CONSTRAINT feature_requests_run_id_automation_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.automation_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_assessments
    ADD CONSTRAINT feedback_assessments_report_id_feedback_reports_id_fk FOREIGN KEY (report_id) REFERENCES public.feedback_reports(id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_integrations
    ADD CONSTRAINT feedback_integrations_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_reports
    ADD CONSTRAINT feedback_reports_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback_reports
    ADD CONSTRAINT feedback_reports_integration_id_feedback_integrations_id_fk FOREIGN KEY (integration_id) REFERENCES public.feedback_integrations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_message_id_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.followed_tasks
    ADD CONSTRAINT followed_tasks_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.gateway_usage
    ADD CONSTRAINT gateway_usage_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.gateway_usage
    ADD CONSTRAINT gateway_usage_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.github_connections
    ADD CONSTRAINT github_connections_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_identities
    ADD CONSTRAINT github_identities_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.github_issues
    ADD CONSTRAINT github_issues_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id);
--> statement-breakpoint
ALTER TABLE ONLY public.kept_sites
    ADD CONSTRAINT kept_sites_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.kept_sites
    ADD CONSTRAINT kept_sites_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.live_activities
    ADD CONSTRAINT live_activities_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_asked_by_id_principals_id_fk FOREIGN KEY (asked_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_plan_message_id_messages_id_fk FOREIGN KEY (plan_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.look_researches
    ADD CONSTRAINT look_researches_thread_root_id_messages_id_fk FOREIGN KEY (thread_root_id) REFERENCES public.messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.merge_intents
    ADD CONSTRAINT merge_intents_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.merge_intents
    ADD CONSTRAINT merge_intents_pr_id_pull_requests_id_fk FOREIGN KEY (pr_id) REFERENCES public.pull_requests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.needs_you_snoozes
    ADD CONSTRAINT needs_you_snoozes_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.needs_you_snoozes
    ADD CONSTRAINT needs_you_snoozes_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_schedules
    ADD CONSTRAINT personal_schedules_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_schedules
    ADD CONSTRAINT personal_schedules_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_schedules
    ADD CONSTRAINT personal_schedules_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_schedules
    ADD CONSTRAINT personal_schedules_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_checks
    ADD CONSTRAINT pr_checks_pr_id_pull_requests_id_fk FOREIGN KEY (pr_id) REFERENCES public.pull_requests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_commits
    ADD CONSTRAINT pr_commits_pr_id_pull_requests_id_fk FOREIGN KEY (pr_id) REFERENCES public.pull_requests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_files
    ADD CONSTRAINT pr_files_pr_id_pull_requests_id_fk FOREIGN KEY (pr_id) REFERENCES public.pull_requests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.pr_reviewers
    ADD CONSTRAINT pr_reviewers_pr_id_pull_requests_id_fk FOREIGN KEY (pr_id) REFERENCES public.pull_requests(id);
--> statement-breakpoint
ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_avatar_attachment_id_attachments_id_fk FOREIGN KEY (avatar_attachment_id) REFERENCES public.attachments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.pull_requests
    ADD CONSTRAINT pull_requests_repo_id_repos_id_fk FOREIGN KEY (repo_id) REFERENCES public.repos(id);
--> statement-breakpoint
ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(id);
--> statement-breakpoint
ALTER TABLE ONLY public.repo_night_runs
    ADD CONSTRAINT repo_night_runs_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_night_runs
    ADD CONSTRAINT repo_night_runs_place_id_repo_places_id_fk FOREIGN KEY (place_id) REFERENCES public.repo_places(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_places
    ADD CONSTRAINT repo_places_added_by_id_principals_id_fk FOREIGN KEY (added_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_places
    ADD CONSTRAINT repo_places_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_places
    ADD CONSTRAINT repo_places_server_id_vault_ssh_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.vault_ssh_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_rules
    ADD CONSTRAINT repo_rules_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_rules
    ADD CONSTRAINT repo_rules_place_id_repo_places_id_fk FOREIGN KEY (place_id) REFERENCES public.repo_places(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_rules
    ADD CONSTRAINT repo_rules_set_by_id_principals_id_fk FOREIGN KEY (set_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_setups
    ADD CONSTRAINT repo_setups_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_setups
    ADD CONSTRAINT repo_setups_place_id_repo_places_id_fk FOREIGN KEY (place_id) REFERENCES public.repo_places(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.repo_setups
    ADD CONSTRAINT repo_setups_started_by_principals_id_fk FOREIGN KEY (started_by) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.repos
    ADD CONSTRAINT repos_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_files
    ADD CONSTRAINT run_files_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_log
    ADD CONSTRAINT run_log_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_steps
    ADD CONSTRAINT run_steps_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_endpoint_id_appliance_endpoints_id_fk FOREIGN KEY (endpoint_id) REFERENCES public.appliance_endpoints(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.search_answers
    ADD CONSTRAINT search_answers_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.search_documents
    ADD CONSTRAINT search_documents_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.server_asks
    ADD CONSTRAINT server_asks_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.server_asks
    ADD CONSTRAINT server_asks_changed_by_id_principals_id_fk FOREIGN KEY (changed_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.server_cares
    ADD CONSTRAINT server_cares_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.server_cares
    ADD CONSTRAINT server_cares_research_id_look_researches_id_fk FOREIGN KEY (research_id) REFERENCES public.look_researches(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.server_names
    ADD CONSTRAINT server_names_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.server_names
    ADD CONSTRAINT server_names_changed_by_id_principals_id_fk FOREIGN KEY (changed_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.server_runner_facts
    ADD CONSTRAINT server_runner_facts_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.server_runner_facts
    ADD CONSTRAINT server_runner_facts_server_id_vault_ssh_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.vault_ssh_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_created_by_id_principals_id_fk FOREIGN KEY (created_by_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.subscription_usage
    ADD CONSTRAINT subscription_usage_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_agent_id_principals_id_fk FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_council_id_councils_id_fk FOREIGN KEY (council_id) REFERENCES public.councils(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_delegation_task_id_delegation_tasks_id_fk FOREIGN KEY (delegation_task_id) REFERENCES public.delegation_tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.t3_watches
    ADD CONSTRAINT t3_watches_person_id_principals_id_fk FOREIGN KEY (person_id) REFERENCES public.principals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_places
    ADD CONSTRAINT thread_places_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_places
    ADD CONSTRAINT thread_places_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_places
    ADD CONSTRAINT thread_places_root_id_messages_id_fk FOREIGN KEY (root_id) REFERENCES public.messages(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_root_id_messages_id_fk FOREIGN KEY (root_id) REFERENCES public.messages(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_cursors
    ADD CONSTRAINT tracker_cursors_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_cursors
    ADD CONSTRAINT tracker_cursors_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_fixes
    ADD CONSTRAINT tracker_fixes_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_grants
    ADD CONSTRAINT tracker_grants_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_grants
    ADD CONSTRAINT tracker_grants_run_id_automation_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.automation_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_items
    ADD CONSTRAINT tracker_items_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_items
    ADD CONSTRAINT tracker_items_connection_id_catalog_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.catalog_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_replies
    ADD CONSTRAINT tracker_replies_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_replies
    ADD CONSTRAINT tracker_replies_report_row_id_tracker_items_id_fk FOREIGN KEY (report_row_id) REFERENCES public.tracker_items(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tracker_updates
    ADD CONSTRAINT tracker_updates_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_entries
    ADD CONSTRAINT vault_entries_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.vault_entries
    ADD CONSTRAINT vault_entries_owner_account_id_accounts_id_fk FOREIGN KEY (owner_account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_entries
    ADD CONSTRAINT vault_entries_owner_id_principals_id_fk FOREIGN KEY (owner_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_networks
    ADD CONSTRAINT vault_networks_added_by_account_id_accounts_id_fk FOREIGN KEY (added_by_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_ssh_servers
    ADD CONSTRAINT vault_ssh_servers_entry_id_vault_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.vault_entries(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_tools
    ADD CONSTRAINT vault_tools_entry_id_vault_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.vault_entries(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.vault_uses
    ADD CONSTRAINT vault_uses_entry_id_vault_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.vault_entries(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.widget_points
    ADD CONSTRAINT widget_points_widget_id_widgets_id_fk FOREIGN KEY (widget_id) REFERENCES public.widgets(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.widgets
    ADD CONSTRAINT widgets_burrow_id_burrows_id_fk FOREIGN KEY (burrow_id) REFERENCES public.burrows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.widgets
    ADD CONSTRAINT widgets_owner_id_principals_id_fk FOREIGN KEY (owner_id) REFERENCES public.principals(id) ON DELETE CASCADE;
--> statement-breakpoint
SELECT pg_catalog.setval('public.authz_generation_seq', 1, true);
