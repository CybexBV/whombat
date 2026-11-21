// Command tufrepo manages TUF repositories for Whombat appliance updates. By default every key it creates is a
// development key and the prod environment is refused. The production pilot (PI-05, MG-40) is explicit: every
// command that touches a production repository needs all three of
//
//	--env prod --custody online-pilot --keys-dir /etc/whombat/secrets/tuf
//
// and only the commands marked [prod] accept them. Development and production keys, repositories and options
// never mix (MA-14). The target custody design stays the maintainers' release-signing runbook.
//
//	tufrepo init --dir D [--env dev|local] [--edition community] [--root-valid 87600h]  [prod]
//	        --edition community: the community edition's own repository (UP-X27): test keys, no assignment key,
//	        whombat-community-YYYYMMDD.N ids only (check-newer --metadata-url takes --edition too)
//	        prod: keys (0600) into --keys-dir, which must be outside D, 0700, owned by the caller and empty;
//	        root 120 days, targets 90, snapshot 7, timestamp 1; no assignment key (control holds it)
//	tufrepo export-root --dir D [--out F]      print or write the current root.json (self-signed; with --env prod
//	        it must trust no development key): what an image pins (manifest/prod/tuf-root.json)
//	tufrepo status --dir D                     versions, expiries, releases with their host, runtime and
//	        manager versions, warnings (JSON)                                                         [prod]
//	tufrepo refresh --dir D [--targets-within 336h] [--clients-within 168h]                          [prod]
//	        re-sign snapshot and timestamp (the 6-hourly timer), plus the clients role and targets when they
//	        expire within the given windows
//	tufrepo resign-root --dir D                a new root version, same keys, fresh expiry          [prod]
//	tufrepo export-release --out R --template tuple.json [--reuse-host] [--nar-cache DIR] [--nix nix] \
//	        [--nix-store nix-store]
//	        a release directory from built store paths (no keys; MG-41, UP-X14, UP-X23): per component its closure
//	        listing <component>.paths.json with the zstd blob of every path in nar/ (hard links into --nar-cache,
//	        default $XDG_CACHE_HOME/whombat-releases/nar, where each NAR is compressed once across releases), NAR
//	        hashes and closure sizes from the store, release.json (v2) and SHA256SUMS (top-level files only).
//	        --reuse-host leaves the host's index out
//	tufrepo publish-release --dir D --release-dir R [--allow-downgrade-from ID[,ID…]] [--channel C]   [prod]
//	        verify R again from its bytes and approve it (artifacts, releases/<id>.json, new targets). Nothing
//	        older is signed (MG-44, MG-50): a production repository signs whombat-YYYYMMDD.N ids only, a development
//	        one whombat-dev-YYYYMMDD.N (ids of no family, fixtures and harness releases, unordered; never a
//	        whombat- id of the other or no family, never a pve- id: PI-23); no host, runtime or manager version may
//	        be lower than the highest one among the published releases of the family (its pve- ids included), the
//	        id must sort after the newest, and versions with a "+" or a numeric part of more than 19 digits are
//	        refused. --allow-downgrade-from makes it a custody rollback: it names only published releases it is
//	        older than, including the ones holding every
//	        version it undercuts, and devices on them may move back to it (TUF-signed allowDowngradeFrom, MA-21c)
//	        Closure indexes: the listings are checked again, each path's blob is the repository's for that NAR hash
//	        or the release directory's nar/<narhex>.nar.zst, verified by decompressing it and written to
//	        targets/nar/<filehex>.<narhex>.nar.zst; the result counts blobsAdded, blobsReused and bytesAdded
//	        --channel development|production lists the release in that channel role, in a repository directory with
//	        channels: what gh-publish signs, without GitHub (a test's update repository; a static server serves it)
//	tufrepo nar-list --dir D                   the NAR hashes (hex) of the repository's blobs, one per line
//	        (read-only, no lock, no keys: production flags are accepted, not required)                      [prod]
//	tufrepo features                           what this tufrepo supports, one per line (closure-index)
//	tufrepo check-newer (--tuple tuple.json | --id ID --host-version V --runtime-version V --manager-version V) \
//	        (--dir D | --metadata-url URL) [--root root.json] [--allow-downgrade-from ID,…]              [prod]
//	        the same check, read-only (no keys, no lock): the metadata chain verified from --root, else from the
//	        repository's own 1.root.json (trusted as found, said so); exit 1 when publishing would be refused.
//	        --metadata-url takes no keys and needs fresh metadata (an expired role fails); --env prod alone
//	        refuses a root that trusts a development key and asks for a production id; --channel development|production
//	        checks against that channel role's releases, whombat- and whombat-dev- ids one family (LNK-22, ONE-04)
//	(add-*/remove sign and publish a new targets version immediately; with --channel development|production they change
//	that channel role instead of the top-level targets: a repository with channels, tufrepo add-channels)
//	tufrepo add-index --dir D --kind runtime|provider|host --target T --file F --version V \
//	        --store-path P --nar-hash sha256:… [--provider NAME] [--manager-store-path P]
//	        a component's closure index for fixture and test releases (UP-X24): its path and, for a host, the
//	        manager's. With the NAR hash of "nar:" + F, F is the path's content (a document the fake activator
//	        imports); with any other, the path is a placeholder for one the box has already (no blob is written)
//	tufrepo add-release --dir D --tuple tuple.json [--client-floor F] [--allow-downgrade-from ID,…]
//	        (an @whombat/release ReleaseTuple; ordered like publish-release)
//	tufrepo add-fake-release --dir D --id ID --host-version V --runtime-version V [--manager-version V] \
//	        [--bad-health] [--no-boot] [--client-floor F]      (not ordered: a fixture, never a real release)
//	        --client-floor sets the tuple's client security floor (CT-53), e.g. android=4021,web=120 (unlisted
//	        platforms 0); `none` removes a floor the tuple file carries. Never on the first release whose
//	        manager/helper use contracts >= 0.5.3 (docs/runbooks/updates.md).
//	tufrepo remove --dir D --target T                     (e.g. releases/<id>.json to unapprove)   [prod]
//	tufrepo publish --dir D | publish-timestamp --dir D                                              [prod]
//	tufrepo rotate --dir D --roles root,targets,snapshot,timestamp
//	tufrepo rotate-assignment-key --dir D [--grace 720h]
//	tufrepo add-assignment-key --dir D --kid K --public-hex H --state active                         [prod]
//	tufrepo add-assignment-key --dir D --kid K --public-hex H --state next --not-before RFC3339|epoch
//	tufrepo add-assignment-key --dir D --kid K --public-hex H --state retired --not-after RFC3339|epoch
//	        (the document must follow the contract state machine, CT-41; invalid documents are refused)
//	tufrepo remove-assignment-key --dir D --kid K                                                    [prod]
//	tufrepo set-assignment-keys --dir D --doc F          (replace the whole document, e.g. control's       [prod]
//	        GET /v1/assignment/keys; its env must be the repository's, CT-41 checks as above)
//	tufrepo expire-timestamp --dir D --at RFC3339
//	tufrepo assign --dir D --device ID --release ID --seq N [--valid 24h] [--out F]
//	tufrepo hold --dir D --device ID --seq N [--valid 24h] [--out F]
//	tufrepo fixtures --out DIR [--at RFC3339] [--valid 87600h]
//	tufrepo add-clients-role --dir D [--key-file F]      (delegate clients/* to the online channel key, MG-33;  [prod]
//	        without --key-file a key is generated and kept with the repository's keys; prod: in --keys-dir,
//	        --key-file (a development key file) is refused)
//	tufrepo clients-keygen --out F                        (a development channel key file)
//	tufrepo clients-keys --dir D [--key-file F] [--out F] (the pinned channel key document for devices)   [prod]
//
// The update channels and the GitHub repository (add-channels, promote, gh-*): github.go.
//
// Every command that loads a repository holds its lock (<dir>/.lock) until it exits.
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: tufrepo <command> [flags] (see source header)")
		os.Exit(2)
	}
	runner := run
	if githubCommands[os.Args[1]] {
		runner = runGitHub
	}
	if err := runner(os.Args[1], os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "tufrepo:", err)
		os.Exit(1)
	}
}

// prodCommands accept --env prod --custody online-pilot --keys-dir.
var prodCommands = map[string]bool{
	"init": true, "status": true, "refresh": true, "resign-root": true, "publish-release": true, "remove": true,
	"publish": true, "publish-timestamp": true, "add-assignment-key": true, "remove-assignment-key": true, "set-assignment-keys": true,
	"add-clients-role": true, "clients-keys": true, "export-root": true, "check-newer": true, "nar-list": true,
}

// features are what this tufrepo supports beyond the commands of its first version (`tufrepo features`; an older
// tufrepo fails on the unknown command).
var features = []string{"closure-index", "channels", "channel-publish", "channel-pause"}

// mode turns --env/--custody/--keys-dir into options, refusing every mix (MA-14).
func mode(cmd, env, custody, keysDir string) (devtuf.Options, error) {
	prod := env == "prod" || env == "production" || custody != "" || keysDir != ""
	if !prod {
		return devtuf.Options{Env: env}, nil
	}
	if env != "prod" || custody != devtuf.CustodyOnlinePilot || keysDir == "" {
		return devtuf.Options{}, fmt.Errorf("production needs all of --env prod --custody %s --keys-dir DIR (PI-05); development repositories take none of them", devtuf.CustodyOnlinePilot)
	}
	if !prodCommands[cmd] {
		return devtuf.Options{}, fmt.Errorf("%s is not available for production repositories", cmd)
	}
	return devtuf.Options{Env: env, Custody: custody, KeysDir: keysDir}, nil
}

// loadWith takes the repository lock (held until unlock; each command is one process) and loads it.
func loadWith(dir string, o devtuf.Options) (r *devtuf.Repo, unlock func(), err error) {
	if dir == "" {
		return nil, nil, errors.New("--dir is required")
	}
	unlock, err = devtuf.Lock(dir, 2*time.Minute)
	if err != nil {
		return nil, nil, err
	}
	r, err = devtuf.Load(dir, devtuf.Options{Custody: o.Custody, Env: o.Env, KeysDir: o.KeysDir})
	if err != nil {
		unlock()
		return nil, nil, err
	}
	return r, unlock, nil
}

func clientsKey(path string) (ed25519.PrivateKey, error) {
	if path == "" {
		return nil, nil
	}
	role, seed, err := devtuf.LoadKeyFile(path)
	if err != nil {
		return nil, err
	}
	if role != trust.ClientsRole {
		return nil, fmt.Errorf("%s is a %q key, not a clients key", path, role)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func run(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	dir := fs.String("dir", "", "repository directory")
	env := fs.String("env", "dev", "assignment key environment (dev|local)")
	kind := fs.String("kind", "", "add-index: runtime, provider or host")
	target := fs.String("target", "", "TUF target path")
	file := fs.String("file", "", "add-index: the component path's content")
	version := fs.String("version", "", "version")
	storePath := fs.String("store-path", "", "Nix store path")
	narHash := fs.String("nar-hash", "", "NAR hash sha256:<hex>")
	provider := fs.String("provider", "", "provider name")
	managerPath := fs.String("manager-store-path", "", "manager store path in the host generation")
	tuplePath := fs.String("tuple", "", "ReleaseTuple JSON file")
	id := fs.String("id", "", "release id")
	hostV := fs.String("host-version", "", "fake host version")
	rtV := fs.String("runtime-version", "", "fake runtime version")
	bad := fs.Bool("bad-health", false, "fake runtime reports unhealthy")
	noBoot := fs.Bool("no-boot", false, "fake host generation fails to boot")
	roles := fs.String("roles", "", "comma-separated roles")
	at := fs.String("at", "", "RFC 3339 time")
	device := fs.String("device", "", "device id")
	rel := fs.String("release", "", "release id")
	seq := fs.Int64("seq", 0, "assignment sequence")
	valid := fs.Duration("valid", 24*time.Hour, "assignment validity (max 168h)")
	out := fs.String("out", "", "output file/dir")
	grace := fs.Duration("grace", 0, "rotate-assignment-key: keep the old key as retired for this long")
	kid := fs.String("kid", "", "assignment key id")
	pubHex := fs.String("public-hex", "", "assignment public key (hex, 32 bytes)")
	notAfter := fs.String("not-after", "", "assignment key notAfter (RFC 3339 or epoch seconds; retired keys)")
	notBefore := fs.String("not-before", "", "assignment key notBefore (RFC 3339 or epoch seconds; next keys)")
	keyState := fs.String("state", "active", "assignment key state: active|next|retired")
	clientFloor := fs.String("client-floor", "", "client security floor platform=build,… (CT-53); none removes it")
	keyFile := fs.String("key-file", "", "clients role key file (development)")
	custody := fs.String("custody", "", "production key custody: online-pilot (PI-05); needs --env prod and --keys-dir")
	keysDir := fs.String("keys-dir", "", "production private keys directory (absolute, 0700, outside --dir)")
	docPath := fs.String("doc", "", "set-assignment-keys: an AssignmentKeys document (control's GET /v1/assignment/keys)")
	releaseDir := fs.String("release-dir", "", "release directory (export-release output)")
	template := fs.String("template", "", "export-release: ReleaseTuple template (narHash fields may be empty)")
	reuseHost := fs.Bool("reuse-host", false, "export-release: leave the host index out (already published)")
	nixStore := fs.String("nix-store", "nix-store", "export-release: the nix-store program")
	nixBin := fs.String("nix", "nix", "export-release: the nix program (path-info)")
	narCache := fs.String("nar-cache", devtuf.DefaultNarCache(), "export-release: the compressed-NAR cache shared by releases")
	targetsWithin := fs.Duration("targets-within", devtuf.TargetsRenewWithin, "refresh: re-sign targets when they expire within this")
	clientsWithin := fs.Duration("clients-within", devtuf.ClientsRenewWithin, "refresh: re-sign the clients role when it expires within this")
	allowDowngrade := fs.String("allow-downgrade-from", "", "custody rollback: releases devices may move back from (comma-separated, MA-21c, MG-44)")
	metadataURL := fs.String("metadata-url", "", "check-newer: a published repository's metadata base URL")
	rootPath := fs.String("root", "", "check-newer: the trusted root.json to verify from (default: the repository's own 1.root.json)")
	mgrV := fs.String("manager-version", "", "check-newer: the candidate's manager version; add-fake-release: the manager's (default the host version)")
	edition := fs.String("edition", "", "init, check-newer --metadata-url: community for the community edition's repository (UP-X27)")
	channel := fs.String("channel", "", "check-newer: the channel role to check against (development or production; ONE-04), not the top level; add-index, add-release, add-fake-release, publish-release, remove, publish: the channel role to change")
	rootValid := fs.Duration("root-valid", 0, "init (development): the root's lifetime (default 365 days)")
	fs.Parse(args)
	if *edition != "" && *edition != devtuf.EditionCommunity {
		return fmt.Errorf("--edition: only %q exists", devtuf.EditionCommunity)
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments %q", fs.Args())
	}
	var allow []string
	if *allowDowngrade != "" {
		allow = strings.Split(*allowDowngrade, ",")
	}
	if cmd == "features" {
		if *dir != "" || *custody != "" || *keysDir != "" {
			return errors.New("features takes no flags")
		}
		for _, f := range features {
			fmt.Println(f)
		}
		return nil
	}
	if cmd == "check-newer" && *metadataURL != "" {
		// A published repository: no keys, no custody; --env prod alone asks for a production root.
		if *custody != "" || *keysDir != "" || *dir != "" {
			return errors.New("--metadata-url reads a published repository: it takes no --dir, --custody or --keys-dir (--env prod alone refuses a development root)")
		}
		if *env != "dev" && *env != "prod" {
			return errors.New("--env is dev or prod")
		}
		cand, err := candidate(*tuplePath, *id, *hostV, *rtV, *mgrV)
		if err != nil {
			return err
		}
		return checkNewer(devtuf.HTTPMetadata{BaseURL: *metadataURL}, *rootPath, *env == "prod", *edition == devtuf.EditionCommunity, true, *channel, cand, allow)
	}
	opts, err := mode(cmd, *env, *custody, *keysDir)
	if err != nil {
		return err
	}
	var unlock func()
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	// --channel makes these commands change that channel role instead of the top-level targets (a development repository
	// with channels, tufrepo add-channels: a release only Beta lists, as the VM tests serve it).
	inChannel := map[string]bool{"add-index": true, "add-release": true, "add-fake-release": true, "remove": true, "publish": true,
		"publish-release": true}
	load := func(dir string) (*devtuf.Repo, error) {
		r, u, err := loadWith(dir, opts)
		unlock = u
		if err == nil && *channel != "" && inChannel[cmd] {
			err = r.InChannel(*channel)
		}
		return r, err
	}
	if opts.Custody != "" && *keyFile != "" {
		return errors.New("--key-file names a development key file; production keys live in --keys-dir")
	}
	// setFloor applies --client-floor to a tuple (unset: the tuple keeps what it has).
	setFloor := func(t *release.ReleaseTuple) error {
		switch *clientFloor {
		case "":
			return nil
		case "none":
			t.ClientFloor = nil
			return nil
		}
		f, err := devtuf.ParseClientFloor(*clientFloor)
		if err != nil {
			return err
		}
		t.ClientFloor = f
		return nil
	}

	switch cmd {
	case "init":
		if *dir == "" {
			return errors.New("--dir is required")
		}
		if opts.Custody != "" {
			r, err := devtuf.New(*dir, opts)
			if err != nil {
				return err
			}
			st := r.Status()
			fmt.Printf("created PRODUCTION repository %s (custody %s, keys in %s); root v%d expires %s\n", *dir, opts.Custody,
				opts.KeysDir, st.Roles["root"].Version, st.Roles["root"].Expires.Format(time.RFC3339))
			fmt.Println("next: add control's assignment key (add-assignment-key) and the clients role (add-clients-role)")
			return nil
		}
		if *env != "dev" && *env != "local" {
			return errors.New("development repositories are for env dev or local only")
		}
		_, err := devtuf.New(*dir, devtuf.Options{Env: *env, Edition: *edition, RootExpiry: *rootValid})
		if err == nil && *edition == devtuf.EditionCommunity {
			fmt.Println("created COMMUNITY repository (test keys, no assignment key)", *dir, "- pin", *dir+"/metadata/1.root.json on community devices")
		} else if err == nil {
			fmt.Println("created DEVELOPMENT repository", *dir, "- pin", *dir+"/metadata/1.root.json on dev devices")
		}
		return err
	case "export-root":
		if *dir == "" {
			return errors.New("--dir is required")
		}
		b, err := devtuf.VerifiedRoot(*dir, opts.Custody != "")
		if err != nil {
			return err
		}
		if *out == "" {
			_, err = os.Stdout.Write(append(b, '\n'))
			return err
		}
		return os.WriteFile(*out, append(b, '\n'), 0o644)
	case "status":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		return printJSON(r.Status())
	case "refresh":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		signed, err := r.Refresh(*targetsWithin, *clientsWithin)
		if err != nil {
			return err
		}
		st := r.Status()
		for _, w := range st.Warnings {
			fmt.Fprintln(os.Stderr, "tufrepo: warning:", w)
		}
		fmt.Printf("re-signed %s; timestamp v%d expires %s\n", strings.Join(signed, ", "), st.Roles["timestamp"].Version,
			st.Roles["timestamp"].Expires.Format(time.RFC3339))
		return nil
	case "resign-root":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		if err := r.ResignRoot(); err != nil {
			return err
		}
		st := r.Status()
		fmt.Printf("root v%d expires %s\n", st.Roles["root"].Version, st.Roles["root"].Expires.Format(time.RFC3339))
		return nil
	case "export-release":
		if *out == "" || *template == "" {
			return errors.New("--out and --template are required")
		}
		tb, err := os.ReadFile(*template)
		if err != nil {
			return err
		}
		start := time.Now()
		m, err := devtuf.ExportRelease(context.Background(), *out, tb, devtuf.ExportOptions{ReuseHost: *reuseHost,
			Paths: devtuf.NixPaths{Nix: *nixBin, NixStore: *nixStore}, NarCache: *narCache,
			Log: func(format string, a ...any) { fmt.Fprintf(os.Stderr, "tufrepo: "+format+"\n", a...) }})
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "tufrepo: exported %s in %s\n", m.ReleaseID, time.Since(start).Round(time.Millisecond))
		return printJSON(m.Tuple)
	case "nar-list":
		// Read-only and keyless: a production repository is listed with or without the production flags.
		if *dir == "" {
			return errors.New("--dir is required")
		}
		blobs, err := devtuf.ListBlobs(*dir)
		if err != nil {
			return err
		}
		hexes := make([]string, 0, len(blobs))
		for h := range blobs {
			hexes = append(hexes, h)
		}
		sort.Strings(hexes)
		w := bufio.NewWriter(os.Stdout)
		for _, h := range hexes {
			fmt.Fprintln(w, h)
		}
		return w.Flush()
	case "publish-release":
		if *releaseDir == "" {
			return errors.New("--release-dir is required")
		}
		r, err := load(*dir)
		if err != nil {
			return err
		}
		res, err := r.PublishRelease(*releaseDir, devtuf.PublishOptions{AllowDowngradeFrom: allow})
		if err != nil {
			return err
		}
		return printJSON(res)
	case "check-newer":
		if *dir == "" {
			return errors.New("--dir or --metadata-url is required")
		}
		if err := devtuf.CheckMode(*dir, opts); err != nil {
			return err
		}
		cand, err := candidate(*tuplePath, *id, *hostV, *rtV, *mgrV)
		if err != nil {
			return err
		}
		return checkNewer(devtuf.DirMetadata(*dir), *rootPath, opts.Custody != "", devtuf.EditionOf(*dir) == devtuf.EditionCommunity, false, *channel, cand, allow)
	case "add-index":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(*file)
		if err != nil {
			return err
		}
		k, ok := map[string]trust.Kind{"runtime": trust.KindRuntimeBundle, "provider": trust.KindProviderBundle, "host": trust.KindHostGeneration}[*kind]
		if !ok {
			return fmt.Errorf("--kind %q: runtime, provider or host", *kind)
		}
		if err := r.AddComponentIndex(*target, trust.IndexMeta{Of: k, Version: *version, StorePath: *storePath, NarHash: *narHash,
			Provider: *provider, ManagerStorePath: *managerPath}, content); err != nil {
			return err
		}
		return r.Publish()
	case "add-release":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(*tuplePath)
		if err != nil {
			return err
		}
		t, err := release.ParseReleaseTuple(b)
		if err != nil {
			return err
		}
		if err := setFloor(t); err != nil {
			return err
		}
		if _, err := r.ApproveRelease(*t, allow); err != nil {
			return err
		}
		return r.Publish()
	case "add-fake-release":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		f := devtuf.StandardRelease(*id, *hostV, *rtV)
		f.ManagerVersion = *mgrV // default: the host version
		if *bad {
			f.RuntimeHealth = "bad"
		}
		f.HostBoots = !*noBoot
		var t release.ReleaseTuple
		if err := setFloor(&t); err != nil {
			return err
		}
		f.ClientFloor = t.ClientFloor
		if _, err = r.AddFakeRelease(f); err != nil {
			return err
		}
		return r.Publish()
	case "remove":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		r.RemoveTarget(*target)
		return r.Publish()
	case "publish":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		return r.Publish()
	case "publish-timestamp":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		return r.PublishTimestamp()
	case "rotate":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		return r.RotateKeys(strings.Split(*roles, ",")...)
	case "rotate-assignment-key":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		if err := r.RotateAssignmentKey(*grace); err != nil {
			return err
		}
		return r.Publish()
	case "add-assignment-key", "remove-assignment-key":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		if cmd == "remove-assignment-key" {
			if err := r.RemoveAssignmentKey(*kid); err != nil {
				return err
			}
			return r.Publish()
		}
		na, err := epoch("--not-after", *notAfter)
		if err != nil {
			return err
		}
		nb, err := epoch("--not-before", *notBefore)
		if err != nil {
			return err
		}
		if err := r.SetAssignmentKey(*kid, strings.ToLower(*pubHex), *keyState, nb, na); err != nil {
			return err
		}
		if err := r.Publish(); err != nil {
			return err
		}
		doc := r.AssignmentKeysDoc()
		b, _ := json.MarshalIndent(doc, "", " ")
		fmt.Println(string(b))
		return nil
	case "set-assignment-keys":
		if *docPath == "" {
			return errors.New("--doc is required")
		}
		b, err := os.ReadFile(*docPath)
		if err != nil {
			return err
		}
		doc, err := release.ParseAssignmentKeys(b)
		if err != nil {
			return err
		}
		r, err := load(*dir)
		if err != nil {
			return err
		}
		if err := r.SetAssignmentKeysDoc(*doc); err != nil {
			return err
		}
		if err := r.Publish(); err != nil {
			return err
		}
		return printJSON(r.AssignmentKeysDoc())
	case "expire-timestamp":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		t, err := time.Parse(time.RFC3339, *at)
		if err != nil {
			return err
		}
		return r.SetTimestampExpiry(t)
	case "assign", "hold":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		var b []byte
		if cmd == "assign" {
			b, err = r.Assign(*device, *rel, *seq, *valid)
		} else {
			b, err = r.Hold(*device, *seq, *valid)
		}
		if err != nil {
			return err
		}
		if *out == "" {
			_, err = os.Stdout.Write(append(b, '\n'))
			return err
		}
		return os.WriteFile(*out, b, 0o644)
	case "fixtures":
		now := time.Now().UTC().Truncate(time.Second)
		if *at != "" {
			t, err := time.Parse(time.RFC3339, *at)
			if err != nil {
				return err
			}
			now = t
		}
		v := *valid
		if v == 24*time.Hour {
			v = 10 * 365 * 24 * time.Hour
		}
		m, err := devtuf.GenerateFixtures(*out, now, v)
		if err != nil {
			return err
		}
		b, _ := json.MarshalIndent(m.Cases, "", " ")
		fmt.Println(string(b))
		return nil
	case "add-clients-role":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		k, err := clientsKey(*keyFile)
		if err != nil {
			return err
		}
		if err := r.AddClientsRole(k); err != nil {
			return err
		}
		fmt.Println("delegated", strings.Join(trust.ClientsRolePaths, " "), "to the clients role")
		return nil
	case "clients-keygen":
		if *out == "" {
			return errors.New("--out is required")
		}
		k := devtuf.NewDevKey()
		if err := devtuf.WriteKeyFile(*out, trust.ClientsRole, k); err != nil {
			return err
		}
		fmt.Printf("%x\n", k.Public().(ed25519.PublicKey))
		return nil
	case "clients-keys":
		r, err := load(*dir)
		if err != nil {
			return err
		}
		doc, err := r.ClientChannelKeys()
		if k, kerr := clientsKey(*keyFile); kerr != nil {
			return kerr
		} else if k != nil {
			doc, err = devtuf.ChannelKeysFor(r.Env, k.Public().(ed25519.PublicKey)), nil
		}
		if err != nil {
			return err
		}
		b, _ := json.MarshalIndent(doc, "", " ")
		if *out == "" {
			fmt.Println(string(b))
			return nil
		}
		return os.WriteFile(*out, append(b, '\n'), 0o644)
	}
	return fmt.Errorf("unknown command %q", cmd)
}

// candidate reads the release to check: a tuple file (a ReleaseTuple, the build's tuple.json or its template:
// only the id and the three versions are read) or the four flags.
func candidate(tuplePath, id, host, runtime, manager string) (devtuf.ReleaseSummary, error) {
	if tuplePath != "" {
		if id != "" || host != "" || runtime != "" || manager != "" {
			return devtuf.ReleaseSummary{}, errors.New("--tuple or --id/--host-version/--runtime-version/--manager-version, not both")
		}
		b, err := os.ReadFile(tuplePath)
		if err != nil {
			return devtuf.ReleaseSummary{}, err
		}
		var t struct {
			ReleaseID string                   `json:"releaseId"`
			Host      struct{ Version string } `json:"host"`
			Runtime   struct{ Version string } `json:"runtime"`
			Manager   struct{ Version string } `json:"manager"`
		}
		if err := json.Unmarshal(b, &t); err != nil {
			return devtuf.ReleaseSummary{}, fmt.Errorf("%s: %w", tuplePath, err)
		}
		id, host, runtime, manager = t.ReleaseID, t.Host.Version, t.Runtime.Version, t.Manager.Version
	}
	if !trust.ValidReleaseID(id) || host == "" || runtime == "" || manager == "" {
		return devtuf.ReleaseSummary{}, errors.New("the candidate needs a release id and host, runtime and manager versions (--tuple, or --id --host-version --runtime-version --manager-version)")
	}
	return devtuf.ReleaseSummary{ID: id, Host: host, Runtime: runtime, Manager: manager}, nil
}

// checkNewer verifies the published repository and runs the ordering check; it says what it verified and what it
// compared, and fails (exit 1) when publishing the candidate would be refused.
// A published repository (--metadata-url) must be fresh: an expired role is a failure, as it is for a device (MG-50); a
// repository on this machine (--dir) is re-signed when something is published, so there it is a warning.
func checkNewer(src devtuf.MetadataSource, rootPath string, production, community, requireFresh bool, channel string, cand devtuf.ReleaseSummary, allow []string) error {
	var root []byte
	if rootPath != "" {
		b, err := os.ReadFile(rootPath)
		if err != nil {
			return err
		}
		root = b
	}
	v, err := devtuf.VerifyPublishedIn(src, root, production, requireFresh, time.Now(), channel)
	if err != nil {
		return fmt.Errorf("%s: %w", src.Describe(), err)
	}
	fmt.Printf("repository %s\n", v.Source)
	for _, s := range v.Verified {
		fmt.Printf("  verified: %s\n", s)
	}
	for _, s := range v.NotVerified {
		fmt.Printf("  not verified: %s\n", s)
	}
	for _, w := range v.Warnings {
		fmt.Printf("  warning: %s\n", w)
	}
	fmt.Printf("candidate %s: host %s, runtime %s, manager %s\n", cand.ID, cand.Host, cand.Runtime, cand.Manager)
	// A channel orders whombat- and whombat-dev- ids as one family (LNK-22), as its publish does (CheckNewer, Channel).
	o, err := devtuf.CheckNewer(v.Releases, cand, devtuf.NewerOptions{Production: production && channel == "", Community: community,
		AllowDowngradeFrom: allow, Channel: channel != ""})
	switch {
	case errors.Is(err, devtuf.ErrReleaseID) || errors.Is(err, devtuf.ErrVersionForm):
	case o.Family == "":
		fmt.Printf("  %s is of no ordered id family (whombat-dev-YYYYMMDD.N here; whombat-YYYYMMDD.N in a channel): not compared\n", cand.ID)
	case o.Newest == nil:
		fmt.Printf("  no %s release is published yet: nothing to compare\n", o.Family)
	default:
		n := o.Newest
		fmt.Printf("  newest published %s release %s; highest published", o.Family, n.ID)
		for _, c := range []string{"host", "runtime", "manager"} {
			if h := o.Highest[c]; h != nil {
				fmt.Printf(" %s %s (%s)", c, h.Version, h.Release)
			}
		}
		fmt.Println()
	}
	if err != nil {
		return err
	}
	for _, d := range o.Downgrades {
		fmt.Printf("  custody rollback (--allow-downgrade-from %s): %s\n", strings.Join(allow, ","), d)
	}
	fmt.Printf("ok: publishing %s would not be refused as older\n", cand.ID)
	return nil
}

func printJSON(v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(b))
	return err
}

func epoch(flag, v string) (*int64, error) {
	if v == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		e := t.Unix()
		return &e, nil
	}
	if e, err := strconv.ParseInt(v, 10, 64); err == nil {
		return &e, nil
	}
	return nil, fmt.Errorf("%s: %q is neither RFC 3339 nor epoch seconds", flag, v)
}
