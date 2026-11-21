// Package coverage is the backup coverage inventory as code (BK-02): what a Whombat appliance
// checkpoint contains, where it comes from on the appliance layout (architecture MA-12), what is left
// out on purpose, and the cache rule. docs/runbooks/backup.md carries the rendered table
// (Markdown()); a test keeps the two identical.
package coverage

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Layout is the appliance's persistent-state layout (MA-12). Tests point Persist at a temp root.
type Layout struct {
	Persist string // "/persist"
	// Hosts: the box runs the hosts service (the servers' hub, Whombat ONE-11), so its backup is a source
	// (BF-18, BK-31). The prod image has none.
	Hosts bool
}

// DefaultLayout is the appliance layout.
func DefaultLayout() Layout { return Layout{Persist: "/persist"} }

func (l Layout) p(parts ...string) string {
	return filepath.Join(append([]string{l.Persist}, parts...)...)
}

// Home is WHOMBAT_HOME (files, skills, runtime-owned state).
func (l Layout) Home() string { return l.p("whombat", "home") }

// Workspaces holds repositories, worktrees and agent working directories.
func (l Layout) Workspaces() string { return l.p("whombat", "workspaces") }

// Credentials holds per-identity provider credential homes: credentials/<account>/<provider>/.
func (l Layout) Credentials() string { return l.p("whombat", "credentials") }

// Hermes is WHOMBAT_HERMES_ROOT, the runner's (NX-431, Whombat one-person.md OP-08): the person's Hermes home in
// Hermes's own layout (memory, sessions, the skills: Hermes's built-ins, hub installs and what the agent learned),
// the outsiders' profile beside it (profiles/_feedback/, OP-17) and the runner's own bookkeeping (pending/: session
// deletes still owed). A subvolume of its own, the `hermes` source (BK-36, NX-466).
func (l Layout) Hermes() string { return l.p("whombat", "hermes") }

// AgentHome is WHOMBAT_AGENT_HOME, the agent's home: its commands' $HOME (what it installed into its home, its own
// files and projects; the containers' bind mounts of it). A subvolume of its own, the `agent` source (NX-465, NX-466).
func (l Layout) AgentHome() string { return l.p("whombat", "agent", "home") }

// Containers is the agent's containers' storage (images, containers, their volumes): never backed up (NX-458).
func (l Layout) Containers() string { return l.p("containers") }

// Secrets holds the application master key.
func (l Layout) Secrets() string { return l.p("secrets") }

// Identity holds the appliance's management and content keys (never backed up, BK-07).
func (l Layout) Identity() string { return l.p("identity") }

// Backup is this service's own state and staging.
func (l Layout) Backup() string { return l.p("backup") }

// HostsData is the hosts service's data directory (its database, the agents' CA, the service token). A
// restore puts the servers' backup there as HostsStagedFile, which the service applies at its next start
// (BK-34).
func (l Layout) HostsData() string { return l.p("hosts") }

// HostsBackup is where the hosts service writes its own backup (HostsBackupFile) just before each
// checkpoint: a subvolume of its own in root's /persist, the `hosts` source (BK-31).
func (l Layout) HostsBackup() string { return l.p("hosts-backup") }

// The hosts service's backup: the file it writes (and the checkpoint carries at files/hosts/), and the names under
// which a restore hands it back to the service. It writes the uncompressed HostsBackupTarFile, which restic
// deduplicates between checkpoints (a gzipped archive changes as a whole every time); a hosts service from before
// writes HostsBackupFile, and checkpoints made then carry it. The backup takes whichever it wrote last. A restore
// stages a plain tar as HostsStagedTarFile and a gzipped one as HostsStagedFile, so an older hosts service, which
// knows only the gzipped name, never takes a plain tar for a damaged archive.
const (
	HostsBackupTarFile = "hub.tar"
	HostsBackupFile    = "hub.tar.gz"
	HostsStagedTarFile = "restore-staged.tar"
	HostsStagedFile    = "restore-staged.tar.gz"
)

// HostsStagedFiles are the names a staged restore of the servers may have.
var HostsStagedFiles = []string{HostsStagedTarFile, HostsStagedFile}

// HostsBackupFiles are the names the hosts service's backup may have, the current first.
var HostsBackupFiles = []string{HostsBackupTarFile, HostsBackupFile}

// Source is one filesystem tree a checkpoint snapshots. Name is also its directory in the snapshot
// (files/<name>) and must be a filesystem snapshot unit (btrfs subvolume / ZFS dataset) on the
// appliance (BK-04).
type Source struct {
	Name string
	Path string
}

// Sources are the trees snapshotted together inside the quiesce, in snapshot order. `hosts` (the hosts
// service's own backup, made just before the quiesce) only where the service runs. `hermes` and `agent` on every box:
// a box without Hermes or the agent's commands (the stand-in runtime's) has no such directory, and the source is
// recorded as missing.
func (l Layout) Sources() []Source {
	s := []Source{
		{Name: "home", Path: l.Home()},
		{Name: "workspaces", Path: l.Workspaces()},
		{Name: "credentials", Path: l.Credentials()},
		{Name: "hermes", Path: l.Hermes()},
		{Name: "agent", Path: l.AgentHome()},
		{Name: "secrets", Path: l.Secrets()},
	}
	if l.Hosts {
		s = append(s, Source{Name: "hosts", Path: l.HostsBackup()})
	}
	return s
}

// Class is one coverage class.
type Class struct {
	ID        string
	Title     string
	Source    string // where it lives
	Method    string // how the checkpoint captures it
	Restore   string // what a restore does / needs
	Covered   bool
	Relogin   bool // provider session state: may need re-login after restore
	Sensitive bool
}

// Classes returns the inventory for a layout, in table order. `servers` only where the hosts service runs.
func Classes(l Layout) []Class {
	cls := []Class{
		{ID: "database", Title: "Database", Covered: true, Sensitive: true,
			Source:  "PostgreSQL 17 database `whombat` (every schema, incl. `whombat_meta` and `drizzle`): channels, threads, DMs, messages, runs, approvals, keys and grants, accounts, principals, endpoint enrollments, recovery authority, audit chain, schedules and automations, connectors (tokens sealed under the master key), command receipts, session events",
			Method:  "`pg_dump -Fc -Z0 --snapshot=<exported>` from the snapshot exported inside the quiesce; row counts and schema version read in the same snapshot",
			Restore: "`pg_restore --no-owner --no-acl` into an empty database; then the runtime's `schema-check` / `migrate --checkpoint`"},
		// Hermes keeps memory, sessions and what the agent learns: one home, the person's (Whombat one-person.md OP-08;
		// BK-36, NX-466). The ID stays `memory`: it is the contract's BackupScope value.
		{ID: "memory", Title: "Memory and conversations", Covered: true, Sensitive: true,
			Source:  "`" + l.Hermes() + "`: the agent's Hermes home — what it remembers (`memories/MEMORY.md`, `USER.md`), its sessions (`state.db` with its write-ahead log, `sessions/`) — with the outsiders' profile (`profiles/_feedback/`) and `" + filepath.Join(l.Hermes(), "pending") + "` (session deletes still owed)",
			Method:  "filesystem snapshot of `hermes` taken inside the same quiesce: one atomic snapshot of the home, so each SQLite store and its write-ahead log are as one instant had them (a running turn's too); each store's sha256 in the manifest",
			Restore: "the home back as it was, each store checked against its sha256; SQLite replays the write-ahead log at the first open. A checkpoint made before the home was backed up has none: the agent starts with an empty memory and new sessions"},
		{ID: "attachments", Title: "Attachments and files", Covered: true, Sensitive: true,
			Source:  "`" + filepath.Join(l.Home(), "files") + "` (content-addressed `sha256/aa/bb/<sha256>`, Feedback screenshots included)",
			Method:  "filesystem snapshot of `home` taken inside the same quiesce; referenced blobs checked present",
			Restore: "files back; every blob's sha256 checked against its name, every blob the database references present"},
		// The ID stays `packs`: it is the contract's BackupScope value (BK-30). The skills are the Hermes home's own
		// skills/ (Whombat OP-08). BK-36, NX-466.
		{ID: "packs", Title: "Skills", Covered: true,
			Source:  "`" + filepath.Join(l.Hermes(), "skills") + "`: the agent's skills — Hermes's built-ins, what was installed from the hub and what the agent learned — and the ones switched off",
			Method:  "filesystem snapshot of `hermes`",
			Restore: "files back; Hermes's own sync brings its built-ins up to date at the next start and keeps the rest"},
		{ID: "home", Title: "Other runtime state", Covered: true,
			Source:  "everything else in `" + l.Home() + "` except the transient names below",
			Method:  "filesystem snapshot of `home`",
			Restore: "files back"},
		{ID: "workspaces", Title: "Workspaces, repositories and the agent's home", Covered: true, Sensitive: true,
			Source:  "`" + l.Workspaces() + "`: whole working trees and `.git` (objects, refs, reflogs, stashes, worktree metadata), so **unpushed commits, uncommitted changes and untracked files** (git-ignored ones too, e.g. `.env`) are in it; and `" + l.AgentHome() + "`, the agent's home (its own files and projects, what it installed there), except its `.cache`",
			Method:  "filesystem snapshots of `workspaces` and `agent`; per-repository inventory (HEAD, branches, unpushed commits, modified and untracked counts) in the manifest",
			Restore: "trees back; worktree/alternates paths relocated; `git fsck` and the manifest's unpushed commits and dirty files checked"},
		{ID: "configuration", Title: "Configuration and master key", Covered: true, Sensitive: true,
			Source:  "`" + l.Secrets() + "` (the master key that seals signing keys and connector tokens in the database); settings live in the database; the NixOS configuration is declarative and identified by the runtime tuple in the manifest",
			Method:  "filesystem snapshot of `secrets`",
			Restore: "master key back (without it the database's sealed secrets can't be opened)"},
		{ID: "provider-sessions", Title: "Provider session state", Covered: true, Relogin: true, Sensitive: true,
			Source:  "`" + l.Credentials() + "/<account>/<provider>/` (per-identity Codex, Claude, GitHub homes)",
			Method:  "filesystem snapshot of `credentials`",
			Restore: "homes back; **may need re-login after restore** (refresh tokens rotate; a replacement must re-verify every login, BK-13)"},
		{ID: "recovery-references", Title: "Recovery material references", Covered: true,
			Source:  "appliance id, management key fingerprint, content PeerId, recovery authority fingerprint, manifest signing key, restic repository id",
			Method:  "recorded in the signed checkpoint manifest (references only, never private keys)",
			Restore: "used to check the kit matches and to reconcile identities on a replacement"},
		{ID: "identity", Title: "Appliance identities", Covered: false,
			Source:  "`" + l.Identity() + "` (management key, content identity)",
			Method:  "not backed up: a replacement gets fresh identities (MA-03, BK-07)",
			Restore: "fresh provisioning; clients re-pin through the recovery or trusted-endpoint ceremony"},
		{ID: "recovery-secrets", Title: "Recovery key and backup password", Covered: false,
			Source:  "customer's recovery kit",
			Method:  "never in a backup (the recovery key never is on the appliance; the repository password opens the backup)",
			Restore: "the kit authorizes the restore"},
		{ID: "manager", Title: "Manager state", Covered: false,
			Source:  "`" + l.p("manager") + "` (journal, TUF cache, staged releases, known-good)",
			Method:  "device-local, rebuilt by provisioning and the update service",
			Restore: "—"},
		{ID: "postgres-datadir", Title: "PostgreSQL data directory", Covered: false,
			Source:  "`" + l.p("postgres", "17") + "`",
			Method:  "replaced by the logical dump (`database`)",
			Restore: "—"},
		{ID: "backup-state", Title: "Backup service state", Covered: false,
			Source:  "`" + l.Backup() + "` (staging, status, manifest key) and `" + l.p("backup-root") + "` (the sealed destination secrets, the pinned backup disk; root only)",
			Method:  "the backup's own state; password, destination credentials and manifest key are in the kit",
			Restore: "re-created by `whombat-backup destination adopt`"},
		{ID: "caches", Title: "Caches", Covered: false,
			Source:  "see the cache rule; and `" + l.Containers() + "`, the agent's containers (their images, the containers and their volumes)",
			Method:  "excluded (regenerable, not authored); the containers are never a source",
			Restore: "regenerated by the project's own install/build; the agent runs its containers again from their images"},
	}
	if !l.Hosts {
		return cls
	}
	// After provider-sessions: the covered classes first, in table order (BF-18, BK-31).
	servers := Class{ID: "servers", Title: "Servers", Covered: true, Sensitive: true,
		Source:  "`" + l.HostsData() + "`, only where the hosts service runs: the servers people added, what Whombat may do on them and their history (its SQLite database), and the agents' CA",
		Method:  "the service's own backup (`whombat-hosts backup`: a consistent copy of the database, and the CA) made as its user just before the quiesce into `" + filepath.Join(l.HostsBackup(), HostsBackupTarFile) + "` (uncompressed; `" + HostsBackupFile + "` from a hosts service from before), then snapshotted as `hosts`; its sha256 and size in the manifest",
		Restore: "the archive checked (its sha256, `manifest.json` and `hub.db` in it), then put at `" + filepath.Join(l.HostsData(), HostsStagedTarFile) + "` (`" + HostsStagedFile + "` when gzipped; the service's, 0600), which the service applies at its next start; its service token and the agents' listener certificate stay the new box's"}
	for i, c := range cls {
		if c.ID == "provider-sessions" {
			return append(cls[:i+1], append([]Class{servers}, cls[i+1:]...)...)
		}
	}
	return append(cls, servers)
}

// HomeTransient are names directly under WHOMBAT_HOME that are process-local and never backed up.
var HomeTransient = []string{
	"logs", "locks", "backups", "diagnostics", "pgdata", "guarded",
	"whombat.pid", "maintenance.lock", "maintenance.json", "last-backup.json",
}

// HermesTransient are names directly under WHOMBAT_HERMES_ROOT that are the runner's per-process state and never
// backed up: its lock holders, unfinished archive transfers (Whombat HE-S114), the home of its `hermes --version`
// check, the ChatGPT sign-in's staging, and Hermes's own logs. HermesProfileTransient are names directly in each of
// Hermes's named profiles (profiles/<name>/): their logs.
var (
	HermesTransient        = []string{"locks", "transfers", "check", "signin", "logs"}
	HermesProfileTransient = []string{"logs"}
)

// CacheDirNames are directory names treated as caches when (and only when) git ignores them in their
// repository (BK-03). A tracked or merely untracked directory of the same name is kept.
var CacheDirNames = []string{
	".angular", ".cache", ".dart_tool", ".direnv", ".gradle", ".mypy_cache", ".next", ".nox",
	".nuxt", ".parcel-cache", ".pnpm-store", ".pytest_cache", ".ruff_cache", ".svelte-kit",
	".terraform", ".tox", ".turbo", "__pycache__", "bower_components", "node_modules",
}

// ConditionalCacheDirs are cache names that also need a marker next to or inside them.
var ConditionalCacheDirs = map[string]string{
	"target": "../Cargo.toml", // Rust build output
	".venv":  "pyvenv.cfg",    // Python virtualenv
	"venv":   "pyvenv.cfg",
}

// AlwaysExcluded are paths (relative to a source) excluded regardless of git: in-flight uploads and
// per-turn scratch that is not acknowledged work.
var AlwaysExcluded = map[string][]string{
	"home":       {"files/.staging"},
	"workspaces": {".scratch", ".push"},
	// The agent's own caches (pip, npm, uv, Chromium's), XDG's place for what can be fetched again.
	"agent": {".cache"},
}

// CacheRule is the human statement of the cache rule, rendered into the docs.
const CacheRule = "A path is a cache, and left out, only if it is regenerable and not authored: (1) a directory " +
	"holding a `CACHEDIR.TAG` (Cache Directory Tagging Specification, restic `--exclude-caches`); or (2) inside a git " +
	"repository, a directory git **ignores** whose name is one of the cache names (for `target` only next to a " +
	"`Cargo.toml`, for `.venv`/`venv` only with a `pyvenv.cfg`); or (3) in-flight uploads (`home/files/.staging`) " +
	"per-turn scratch and transient push repositories (`workspaces/.scratch`, `workspaces/.push`), and the agent's own caches (`agent/.cache`). Everything else is kept, including git-ignored files that are " +
	"not caches (`.env`, local config) and untracked directories named like caches. The excluded paths of each " +
	"checkpoint are listed in its manifest."

// IsCacheName reports whether name is an unconditional cache directory name.
func IsCacheName(name string) bool {
	i := sort.SearchStrings(CacheDirNames, name)
	return i < len(CacheDirNames) && CacheDirNames[i] == name
}

// Markdown renders the coverage table and rules (the generated part of docs/runbooks/backup.md).
func Markdown(l Layout) string {
	var b strings.Builder
	b.WriteString("| Class | Covered | Source | Checkpoint method | Restore |\n|---|---|---|---|---|\n")
	for _, c := range Classes(l) {
		cov := "yes"
		if !c.Covered {
			cov = "**no**"
		}
		if c.Relogin {
			cov += " (re-login)"
		}
		fmt.Fprintf(&b, "| %s (`%s`) | %s | %s | %s | %s |\n", c.Title, c.ID, cov, c.Source, c.Method, c.Restore)
	}
	b.WriteString("\nTransient names under `" + l.Home() + "`, never backed up: `" + strings.Join(HomeTransient, "`, `") + "`. Under `" +
		l.Hermes() + "`: `" + strings.Join(HermesTransient, "`, `") + "`, and in each of its profiles `" + strings.Join(HermesProfileTransient, "`, `") + "`.\n\n")
	b.WriteString("**Cache rule.** " + CacheRule + "\n\nCache names: `" + strings.Join(CacheDirNames, "`, `") + "`; conditional: ")
	keys := make([]string, 0, len(ConditionalCacheDirs))
	for k := range ConditionalCacheDirs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for i, k := range keys {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "`%s` (needs `%s`)", k, ConditionalCacheDirs[k])
	}
	b.WriteString(".\n")
	return b.String()
}

// CheckRoots reports configured runtime directories (e.g. agent workdir roots) that fall outside every
// covered source: work kept there would silently not be backed up.
func CheckRoots(l Layout, roots []string) []string {
	var outside []string
	for _, r := range roots {
		r = filepath.Clean(r)
		ok := false
		for _, s := range l.Sources() {
			if r == s.Path || strings.HasPrefix(r, s.Path+string(filepath.Separator)) {
				ok = true
				break
			}
		}
		if !ok {
			outside = append(outside, r)
		}
	}
	return outside
}
