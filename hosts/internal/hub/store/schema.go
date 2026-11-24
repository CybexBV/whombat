package store

// migrations are applied in order; PRAGMA user_version is the number
// applied. Statements are separated by lines containing only "--;".
// Times are unix milliseconds, except metric timestamps (unix seconds).
var migrations = []string{
	// 1: initial schema.
	`
CREATE TABLE meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
)
--;
CREATE TABLE servers (
	id             TEXT PRIMARY KEY,
	hostname       TEXT NOT NULL,
	grp            TEXT NOT NULL DEFAULT '',
	location       TEXT NOT NULL DEFAULT '',
	rc_console     INTEGER NOT NULL DEFAULT 0,
	rc_power       INTEGER NOT NULL DEFAULT 0,
	cert_serial    TEXT NOT NULL,
	cert_not_after INTEGER NOT NULL,
	machine_id     TEXT NOT NULL DEFAULT '',
	created_at     INTEGER NOT NULL,
	last_seen      INTEGER,
	agent_version  TEXT NOT NULL DEFAULT '',
	address        TEXT NOT NULL DEFAULT ''
)
--;
CREATE TABLE server_reports (
	server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
	at        INTEGER NOT NULL,
	report    BLOB NOT NULL
)
--;
CREATE TABLE enrollments (
	id               TEXT PRIMARY KEY,
	token_hash       BLOB NOT NULL UNIQUE,
	state            TEXT NOT NULL,
	created_by       TEXT NOT NULL,
	created_at       INTEGER NOT NULL,
	expires_at       INTEGER NOT NULL,
	poll_secret_hash BLOB,
	csr              BLOB,
	hostname         TEXT NOT NULL DEFAULT '',
	machine_id       TEXT NOT NULL DEFAULT '',
	os               TEXT NOT NULL DEFAULT '',
	address          TEXT NOT NULL DEFAULT '',
	remote_addr      TEXT NOT NULL DEFAULT '',
	agent_version    TEXT NOT NULL DEFAULT '',
	requested_at     INTEGER,
	server_id        TEXT,
	certificate      BLOB,
	decided_at       INTEGER,
	decided_by       TEXT
)
--;
CREATE INDEX enrollments_state ON enrollments(state)
--;
CREATE TABLE users (
	id                  INTEGER PRIMARY KEY,
	username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
	role                TEXT NOT NULL,
	password_hash       TEXT NOT NULL,
	webauthn_id         BLOB NOT NULL,
	created_at          INTEGER NOT NULL,
	password_changed_at INTEGER NOT NULL
)
--;
CREATE TABLE sessions (
	id_hash      BLOB PRIMARY KEY,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	csrf         TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL,
	ip           TEXT NOT NULL DEFAULT '',
	user_agent   TEXT NOT NULL DEFAULT ''
)
--;
CREATE INDEX sessions_user ON sessions(user_id)
--;
CREATE TABLE passkeys (
	id           BLOB PRIMARY KEY,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name         TEXT NOT NULL,
	credential   BLOB NOT NULL,
	created_at   INTEGER NOT NULL,
	last_used_at INTEGER
)
--;
CREATE TABLE alerts (
	id            TEXT PRIMARY KEY,
	server_id     TEXT NOT NULL,
	key           TEXT NOT NULL,
	rule          TEXT NOT NULL,
	entity        TEXT NOT NULL,
	severity      TEXT NOT NULL,
	title         TEXT NOT NULL,
	detail        TEXT NOT NULL,
	banner_title  TEXT NOT NULL DEFAULT '',
	banner_detail TEXT NOT NULL DEFAULT '',
	link          TEXT NOT NULL DEFAULT '',
	status_note   TEXT NOT NULL DEFAULT '',
	state         TEXT NOT NULL,
	opened_at     INTEGER NOT NULL,
	resolved_at   INTEGER
)
--;
CREATE INDEX alerts_state ON alerts(state, server_id)
--;
CREATE INDEX alerts_opened ON alerts(opened_at)
--;
CREATE UNIQUE INDEX alerts_open_key ON alerts(server_id, key) WHERE state = 'open'
--;
CREATE TABLE audit (
	seq        INTEGER PRIMARY KEY AUTOINCREMENT,
	id         TEXT NOT NULL UNIQUE,
	at         INTEGER NOT NULL,
	user       TEXT NOT NULL DEFAULT '',
	role       TEXT NOT NULL DEFAULT '',
	client_ip  TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	server     TEXT NOT NULL DEFAULT '',
	guest      TEXT NOT NULL DEFAULT '',
	platform   TEXT NOT NULL DEFAULT '',
	event      TEXT NOT NULL,
	protocol   TEXT NOT NULL DEFAULT '',
	outcome    TEXT NOT NULL,
	code       TEXT NOT NULL DEFAULT '',
	duration_s REAL,
	bytes_in   INTEGER,
	bytes_out  INTEGER,
	details    TEXT NOT NULL DEFAULT ''
)
--;
CREATE INDEX audit_at ON audit(at)
--;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN
	SELECT RAISE(ABORT, 'audit log is append-only');
END
--;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
WHEN old.at > (CAST(strftime('%s', 'now') AS INTEGER) - 366 * 86400) * 1000
BEGIN
	SELECT RAISE(ABORT, 'audit log is append-only');
END
--;
CREATE TABLE series (
	id        INTEGER PRIMARY KEY,
	server_id TEXT NOT NULL,
	name      TEXT NOT NULL,
	UNIQUE (server_id, name)
)
--;
CREATE TABLE metrics_raw (
	series_id INTEGER NOT NULL,
	ts        INTEGER NOT NULL,
	value     REAL NOT NULL,
	PRIMARY KEY (series_id, ts)
) WITHOUT ROWID
--;
CREATE TABLE metrics_1m (
	series_id INTEGER NOT NULL,
	ts        INTEGER NOT NULL,
	avg       REAL NOT NULL,
	max       REAL NOT NULL,
	count     INTEGER NOT NULL,
	PRIMARY KEY (series_id, ts)
) WITHOUT ROWID
--;
CREATE TABLE metrics_15m (
	series_id INTEGER NOT NULL,
	ts        INTEGER NOT NULL,
	avg       REAL NOT NULL,
	max       REAL NOT NULL,
	count     INTEGER NOT NULL,
	PRIMARY KEY (series_id, ts)
) WITHOUT ROWID
`,
	// 2: the certificate an agent had before a renewal stays valid until the
	// agent connects with the renewed one (a lost HelloAck must not lock the
	// agent out).
	`
ALTER TABLE servers ADD COLUMN prev_cert_serial TEXT NOT NULL DEFAULT ''
`,
	// 3: fleet charts look series up by name across servers.
	`
CREATE INDEX series_name ON series(name)
`,
	// 4: sessions get an absolute lifetime, a re-authentication time and an
	// optional role cap (kiosk links); hosts get host-access toggles and a
	// parent (dependency suppression); users get their sign-in source.
	`
ALTER TABLE sessions ADD COLUMN absolute_expires_at INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE sessions ADD COLUMN role_cap TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE sessions ADD COLUMN kiosk INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE servers ADD COLUMN rc_host_shell INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE servers ADD COLUMN rc_host_power INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE servers ADD COLUMN parent TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
--;
ALTER TABLE users ADD COLUMN oidc_subject TEXT NOT NULL DEFAULT ''
--;
CREATE INDEX users_oidc ON users(oidc_subject) WHERE oidc_subject != ''
`,
	// 5: API tokens (scripts, Prometheus, kiosk links).
	`
CREATE TABLE api_tokens (
	id           TEXT PRIMARY KEY,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name         TEXT NOT NULL,
	token_hash   BLOB NOT NULL UNIQUE,
	role         TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	last_used_at INTEGER,
	expires_at   INTEGER
)
--;
CREATE INDEX api_tokens_user ON api_tokens(user_id)
--;
ALTER TABLE sessions ADD COLUMN token_id TEXT NOT NULL DEFAULT ''
`,
	// 6: alert acknowledgements and maintenance windows.
	`
ALTER TABLE alerts ADD COLUMN ack_at INTEGER
--;
ALTER TABLE alerts ADD COLUMN ack_by TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE alerts ADD COLUMN ack_note TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE alerts ADD COLUMN ack_until INTEGER
--;
CREATE INDEX alerts_server_opened ON alerts(server_id, opened_at)
--;
CREATE TABLE maintenance (
	id           TEXT PRIMARY KEY,
	scope        TEXT NOT NULL,
	target       TEXT NOT NULL DEFAULT '',
	starts_at    INTEGER NOT NULL,
	ends_at      INTEGER,
	weekdays     TEXT NOT NULL DEFAULT '',
	start_minute INTEGER NOT NULL DEFAULT 0,
	duration_min INTEGER NOT NULL DEFAULT 0,
	tz           TEXT NOT NULL DEFAULT 'UTC',
	note         TEXT NOT NULL DEFAULT '',
	created_by   TEXT NOT NULL,
	created_at   INTEGER NOT NULL
)
`,
	// 7: notification channels, the delivery log, and when an alert was
	// first notified (not resent after a restart).
	`
CREATE TABLE channels (
	id            TEXT PRIMARY KEY,
	name          TEXT NOT NULL,
	kind          TEXT NOT NULL,
	url           TEXT NOT NULL,
	min_severity  TEXT NOT NULL DEFAULT 'warning',
	groups        TEXT NOT NULL DEFAULT '',
	send_resolved INTEGER NOT NULL DEFAULT 1,
	reminder_min  INTEGER NOT NULL DEFAULT 0,
	enabled       INTEGER NOT NULL DEFAULT 1,
	options       TEXT NOT NULL DEFAULT '',
	created_by    TEXT NOT NULL,
	created_at    INTEGER NOT NULL
)
--;
CREATE TABLE deliveries (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id TEXT NOT NULL,
	at         INTEGER NOT NULL,
	kind       TEXT NOT NULL,
	alert_ids  TEXT NOT NULL DEFAULT '',
	summary    TEXT NOT NULL DEFAULT '',
	ok         INTEGER NOT NULL,
	error      TEXT NOT NULL DEFAULT '',
	attempt    INTEGER NOT NULL DEFAULT 1
)
--;
CREATE INDEX deliveries_at ON deliveries(at)
--;
ALTER TABLE alerts ADD COLUMN notified_at INTEGER
`,
	// 8: checks (HTTP / TCP / ping / DNS from the hub or an agent, and
	// heartbeat checks pinged by cron jobs) and their latest result.
	`
CREATE TABLE checks (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	kind       TEXT NOT NULL,
	target     TEXT NOT NULL DEFAULT '',
	runner     TEXT NOT NULL DEFAULT 'hub',
	interval_s INTEGER NOT NULL DEFAULT 60,
	timeout_s  INTEGER NOT NULL DEFAULT 10,
	options    TEXT NOT NULL DEFAULT '',
	token      TEXT NOT NULL DEFAULT '',
	grace_s    INTEGER NOT NULL DEFAULT 0,
	enabled    INTEGER NOT NULL DEFAULT 1,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
)
--;
CREATE UNIQUE INDEX checks_token ON checks(token) WHERE token != ''
--;
CREATE TABLE check_state (
	check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
	result   BLOB NOT NULL,
	since    INTEGER NOT NULL
)
`,
	// 9: accounts: the last sign-in, "choose a new password at the next
	// sign-in" (temporary passwords set by an admin), and API tokens get a
	// kind (api, or kiosk: a wall-display link that is not a bearer token).
	`
ALTER TABLE users ADD COLUMN last_login_at INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api'
`,
	// 10: the hub's switch for managing guests (configuration, create,
	// delete, backups; docs/MANAGE.md), off on every server.
	`
ALTER TABLE servers ADD COLUMN rc_manage INTEGER NOT NULL DEFAULT 0
`,
	// 11: the assistant (docs/ASSIST.md): its read-only checks are on for
	// every server; investigations and their transcripts.
	`
ALTER TABLE servers ADD COLUMN rc_diagnose INTEGER NOT NULL DEFAULT 1
--;
CREATE TABLE assist_sessions (
	id               TEXT PRIMARY KEY,
	title            TEXT NOT NULL,
	server_id        TEXT NOT NULL DEFAULT '',
	server_name      TEXT NOT NULL DEFAULT '',
	alert_id         TEXT NOT NULL DEFAULT '',
	provider         TEXT NOT NULL,
	model            TEXT NOT NULL DEFAULT '',
	state            TEXT NOT NULL,
	access           TEXT NOT NULL,
	auto             INTEGER NOT NULL DEFAULT 0,
	created_by       TEXT NOT NULL,
	created_at       INTEGER NOT NULL,
	updated_at       INTEGER NOT NULL,
	provider_session TEXT NOT NULL DEFAULT '',
	summary          TEXT NOT NULL DEFAULT '',
	resolved         INTEGER,
	cost_usd         REAL
)
--;
CREATE INDEX assist_sessions_alert ON assist_sessions(alert_id) WHERE alert_id != ''
--;
CREATE INDEX assist_sessions_created ON assist_sessions(created_at)
--;
CREATE TABLE assist_events (
	session_id TEXT NOT NULL REFERENCES assist_sessions(id) ON DELETE CASCADE,
	seq        INTEGER NOT NULL,
	at         INTEGER NOT NULL,
	kind       TEXT NOT NULL,
	data       TEXT NOT NULL,
	PRIMARY KEY (session_id, seq)
) WITHOUT ROWID
`,
	// 12: Whombat's pre-approved enrollments (Add a server, SI-07): approve
	// when the agent asks, with this control level, name and group.
	`
ALTER TABLE enrollments ADD COLUMN approve INTEGER NOT NULL DEFAULT 0
--;
ALTER TABLE enrollments ADD COLUMN control TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE enrollments ADD COLUMN name TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE enrollments ADD COLUMN grp TEXT NOT NULL DEFAULT ''
`,
	// 13: per-server watch settings (HS-194): an alert rule switched off for
	// a server ('' entity) or for one of its entities (a disk, a guest).
	`
CREATE TABLE watch_offs (
	server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
	rule      TEXT NOT NULL,
	entity    TEXT NOT NULL DEFAULT '',
	by_user   TEXT NOT NULL,
	at        INTEGER NOT NULL,
	PRIMARY KEY (server_id, rule, entity)
) WITHOUT ROWID
`,
	// 14: latest on-request disk usage breakdown per server and mount point.
	`
CREATE TABLE server_disk_usage (
	server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
	mount       TEXT NOT NULL,
	measured_at INTEGER NOT NULL,
	data        BLOB NOT NULL,
	PRIMARY KEY (server_id, mount)
) WITHOUT ROWID
`,
	// 15: check ownership and per-server alert limits.
	`
ALTER TABLE checks ADD COLUMN owner TEXT NOT NULL DEFAULT ''
--;
ALTER TABLE checks ADD COLUMN probe_rev TEXT NOT NULL DEFAULT ''
--;
CREATE TABLE watch_limits (
	server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
	rule      TEXT NOT NULL,
	entity    TEXT NOT NULL DEFAULT '',
	value     REAL NOT NULL,
	PRIMARY KEY (server_id, rule, entity)
) WITHOUT ROWID
`,
}
