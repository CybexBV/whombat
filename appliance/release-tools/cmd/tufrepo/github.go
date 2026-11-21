package main

// The update channels and the GitHub repository (Whombat LNK-20…LNK-27, UP-X29):
//
//	tufrepo add-channels --dir D [--production-key-out F]
//	        delegate development/* and production/* (top-level targets key); the development key is kept with the
//	        repository's keys, the production key only when --production-key-out is not given (else written there)
//	tufrepo promote --dir D --release ID [--key-file F]
//	        list a development release, unchanged, in production (F: the offline production key)
//	tufrepo pause --dir D [--channel production|development] [--key-file F]
//	        sign the pause marker into the channel's own role metadata so boxes stop taking new releases from it
//	tufrepo resume --dir D [--channel production|development] [--key-file F]
//	        clear the pause marker from the channel's own role metadata so boxes resume taking releases from it
//	tufrepo gh-continue --from SRC --out D --keys-dir K --offline-keys-dir O --carry ID,… [--from-keys-dir S] [--version-gap N]
//	        the GitHub repository from a COPY of DEV's (never the live one): root chain and versions carried on,
//	        channel roles added; K keeps the online keys (root, targets, development, clients), O receives the
//	        snapshot and timestamp keys (Actions secrets) and the production key (offline). --carry lists the
//	        source's releases in development unchanged: the one every DEV box runs now and the bridge. Prints what
//	        the bridge release must carry (also D/continue.json)
//	tufrepo gh-init --dir D --remote URL                 make D the clone the publisher works in and push it: first
//	        every file its metadata names (the carried releases, the clients role's targets) uploaded and verified
//	tufrepo gh-publish --dir D --release-dir R [--allow-downgrade-from ID,…]
//	        publish a release directory into development: blobs → release assets → role metadata (git push)
//	tufrepo gh-promote --dir D --release ID [--key-file F] promote and push (nothing is uploaded again); the production
//	        key from F, else the repository's own (online since the key ceremony, ONE-05)
//	tufrepo gh-pause --dir D [--channel production|development] [--key-file F]
//	        pause the channel and push its signed role metadata (nothing is uploaded)
//	tufrepo gh-resume --dir D [--channel production|development] [--key-file F]
//	        resume the channel and push its signed role metadata (nothing is uploaded)
//	tufrepo gh-rotate --dir D --offline-keys-dir O [--production-key-file F] [--local]
//	        the key ceremony (ONE-05, devtuf/rotate.go): a new root signed by the current root keys and three new ones
//	        (two of them sign the next), a new top-level targets key, the targets signed again; the new keys and a copy
//	        of the production key into O (new or empty, 0700); the repository keeps development, clients and
//	        production online (F: the production key when gh-continue put it offline). Pushed like a publish; the old
//	        root and targets keys leave the keys folder only once the push succeeded. Stopped (while signing or at the
//	        push), the same command carries on: the same keys, nothing signed twice (R1 #4). --local only signs in D
//	        (a copy, a rehearsal). Prints what it did
//	tufrepo gh-rotate --dir D --check           what a ceremony would do, from the public metadata alone (no key)
//	tufrepo gh-clients-env --dir D --env prod   sign the AI client channel for env prod from its next version on (ONE-05:
//	        production boxes accept only a channel of their env); then `clientchannel publish --repo D`, `tufrepo
//	        gh-clients --dir D` and `tufrepo clients-keys --dir D --out manifest/prod/client-channel-keys.json`
//	tufrepo gh-clients --dir D                           upload the clients role's targets to the `clients` release
//	tufrepo gh-resign --metadata M [--snapshot-key-env TUF_SNAPSHOT_KEY] [--timestamp-key-env TUF_TIMESTAMP_KEY]
//	        the workflow's step: snapshot and timestamp over the newest role files that verify (keys from the env)
//	tufrepo gh-expiry --metadata M [--warn-days 30,14,7] [--annotations]
//	        each role's expiry; with --annotations GitHub workflow warnings (::warning / ::error at the last step)
//
// The gh- commands that talk to GitHub take --owner (CybexBV) --repo (whombat-releases) --api
// (https://api.github.com) --branch (main) and the token from the environment variable --token-env
// (WHOMBAT_RELEASES_TOKEN).

import (
	"context"
	"crypto/ed25519"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/appliance/release-tools/ghpublish"
)

var githubCommands = map[string]bool{"add-channels": true, "promote": true, "pause": true, "resume": true,
	"gh-continue": true, "gh-init": true, "gh-publish": true, "gh-promote": true, "gh-pause": true, "gh-resume": true,
	"gh-clients": true, "gh-resign": true, "gh-expiry": true, "gh-rotate": true, "gh-clients-env": true}

func runGitHub(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	dir := fs.String("dir", "", "repository directory")
	from := fs.String("from", "", "gh-continue: a copy of the DEV repository")
	fromKeys := fs.String("from-keys-dir", "", "gh-continue: the DEV repository's keys (when not in its keys/)")
	out := fs.String("out", "", "gh-continue: the new repository directory (empty)")
	keysDir := fs.String("keys-dir", "", "gh-continue: the online keys (absolute, outside --out)")
	offline := fs.String("offline-keys-dir", "", "gh-continue: keys that leave the build server (absolute)")
	gap := fs.Int64("version-gap", 10000, "gh-continue: added to targets, snapshot and timestamp versions")
	carry := fs.String("carry", "", "gh-continue: release ids listed in development unchanged (the boxes' release before the bridge, the bridge)")
	prodOut := fs.String("production-key-out", "", "add-channels: write the production key here instead of keeping it")
	rel := fs.String("release", "", "release id")
	channel := fs.String("channel", trust.ChannelProduction, "pause, resume, gh-pause, gh-resume: update channel (production or development)")
	keyFile := fs.String("key-file", "", "channel signing key file (when not kept in the repository)")
	prodKeyFile := fs.String("production-key-file", "", "gh-rotate: the production key, when the repository doesn't hold it")
	local := fs.Bool("local", false, "gh-rotate: sign in --dir only, push nothing (a copy, a rehearsal)")
	check := fs.Bool("check", false, "gh-rotate: what a ceremony would do, from the public metadata")
	clientsEnv := fs.String("env", "", "gh-clients-env: the env the client channel is signed for (prod)")
	releaseDir := fs.String("release-dir", "", "gh-publish: a release directory (release/build)")
	allow := fs.String("allow-downgrade-from", "", "gh-publish: custody rollback from these releases")
	remote := fs.String("remote", "", "gh-init: the releases repository's git URL")
	owner := fs.String("owner", "CybexBV", "GitHub owner")
	repo := fs.String("repo", "whombat-releases", "GitHub repository")
	api := fs.String("api", "https://api.github.com", "GitHub REST API")
	branch := fs.String("branch", "main", "the branch the metadata is pushed to")
	tokenEnv := fs.String("token-env", ghpublish.TokenEnv, "the environment variable with the GitHub token")
	metaDir := fs.String("metadata", "", "gh-resign, gh-expiry: the metadata folder")
	snapEnv := fs.String("snapshot-key-env", "TUF_SNAPSHOT_KEY", "gh-resign: the variable holding the snapshot key file")
	tsEnv := fs.String("timestamp-key-env", "TUF_TIMESTAMP_KEY", "gh-resign: the variable holding the timestamp key file")
	warnDays := fs.String("warn-days", "30,14,7", "gh-expiry: warn this many days before a role expires")
	annotations := fs.Bool("annotations", false, "gh-expiry, gh-resign: GitHub workflow annotations")
	fs.Parse(args)
	ctx := context.Background()
	publisher := func() (*ghpublish.Publisher, error) {
		tok := os.Getenv(*tokenEnv)
		if tok == "" {
			return nil, fmt.Errorf("%s is empty: the publisher needs a GitHub token with Contents write on %s/%s", *tokenEnv, *owner, *repo)
		}
		return ghpublish.New(ghpublish.Config{Dir: *dir, Owner: *owner, Repo: *repo, APIURL: *api, Token: tok, Branch: *branch,
			Log: func(f string, a ...any) { fmt.Fprintf(os.Stderr, "gh: "+f+"\n", a...) }})
	}
	channelKey := func(ch string) (devtufKey, error) {
		if *keyFile == "" {
			return nil, nil
		}
		return devtuf.ReadKeyFile(*keyFile, ch)
	}
	productionKey := func() (devtufKey, error) { return channelKey(trust.ChannelProduction) }
	switch cmd {
	case "add-channels":
		unlock, err := devtuf.Lock(*dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlock()
		r, err := devtuf.Load(*dir, devtuf.Options{})
		if err != nil {
			return err
		}
		keys, keep := map[string]devtufKey{}, map[string]bool{trust.ChannelDevelopment: true, trust.ChannelProduction: *prodOut == ""}
		if *prodOut != "" {
			keys[trust.ChannelProduction] = devtuf.NewDevKey()
			if err := devtuf.WriteKeyFile(*prodOut, trust.ChannelProduction, keys[trust.ChannelProduction]); err != nil {
				return err
			}
		}
		if err := r.AddChannelRoles(keys, keep); err != nil {
			return err
		}
		return printJSON(r.RoleVersions())
	case "promote":
		unlock, err := devtuf.Lock(*dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlock()
		r, err := devtuf.Load(*dir, devtuf.Options{})
		if err != nil {
			return err
		}
		k, err := productionKey()
		if err != nil {
			return err
		}
		res, err := r.Promote(*rel, trust.ChannelDevelopment, trust.ChannelProduction, k)
		if err != nil {
			return err
		}
		return printJSON(res)
	case "pause", "resume":
		if !trust.ValidChannel(*channel) {
			return fmt.Errorf("unknown channel %q (use %s)", *channel, strings.Join(trust.Channels, " or "))
		}
		unlock, err := devtuf.Lock(*dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlock()
		r, err := devtuf.Load(*dir, devtuf.Options{})
		if err != nil {
			return err
		}
		k, err := channelKey(*channel)
		if err != nil {
			return err
		}
		var res *devtuf.ChannelPauseResult
		if cmd == "pause" {
			res, err = r.PauseChannel(*channel, k)
		} else {
			res, err = r.ResumeChannel(*channel, k)
		}
		if err != nil {
			return err
		}
		if cmd == "pause" {
			fmt.Fprintf(os.Stderr, "tufrepo: note: %s\n", devtuf.ChannelPauseScopeNote)
		}
		return printJSON(res)
	case "gh-continue":
		var ids []string
		if *carry != "" {
			ids = strings.Split(*carry, ",")
		}
		res, err := devtuf.Continue(*from, *out, devtuf.ContinueOptions{SourceKeysDir: *fromKeys, KeysDir: *keysDir,
			OfflineKeysDir: *offline, VersionGap: *gap, Carry: ids})
		if err != nil {
			return err
		}
		return printJSON(res)
	case "gh-init":
		p, err := publisher()
		if err != nil {
			return err
		}
		head, err := p.InitClone(ctx, *remote)
		if err != nil {
			return err
		}
		fmt.Println(head)
		return nil
	case "gh-publish":
		p, err := publisher()
		if err != nil {
			return err
		}
		var from []string
		if *allow != "" {
			from = strings.Split(*allow, ",")
		}
		res, pr, err := p.PublishRelease(ctx, trust.ChannelDevelopment, *releaseDir, from)
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"github": res, "release": pr})
	case "gh-promote":
		p, err := publisher()
		if err != nil {
			return err
		}
		// No --key-file: the repository's own production key (online since the key ceremony, ONE-05); without one there
		// the promotion is refused before anything is signed.
		k, err := productionKey()
		if err != nil {
			return err
		}
		res, err := p.Promote(ctx, *rel, k)
		if err != nil {
			return err
		}
		return printJSON(res)
	case "gh-pause", "gh-resume":
		if !trust.ValidChannel(*channel) {
			return fmt.Errorf("unknown channel %q (use %s)", *channel, strings.Join(trust.Channels, " or "))
		}
		p, err := publisher()
		if err != nil {
			return err
		}
		k, err := channelKey(*channel)
		if err != nil {
			return err
		}
		var (
			res *ghpublish.Result
			pr  *devtuf.ChannelPauseResult
		)
		if cmd == "gh-pause" {
			res, pr, err = p.PauseChannel(ctx, *channel, k)
		} else {
			res, pr, err = p.ResumeChannel(ctx, *channel, k)
		}
		if err != nil {
			return err
		}
		if cmd == "gh-pause" {
			fmt.Fprintf(os.Stderr, "tufrepo: note: %s\n", devtuf.ChannelPauseScopeNote)
		}
		return printJSON(map[string]any{"github": res, "channel": pr})
	case "gh-rotate":
		if *check {
			plan, err := devtuf.PlanRotation(filepath.Join(*dir, "metadata"))
			if err != nil {
				return err
			}
			return printJSON(plan)
		}
		var prod devtufKey
		if *prodKeyFile != "" {
			k, err := devtuf.ReadKeyFile(*prodKeyFile, trust.ChannelProduction)
			if err != nil {
				return err
			}
			prod = k
		}
		opts := devtuf.RotateOptions{OfflineDir: *offline, ProductionKey: prod}
		if *local {
			// A copy, a rehearsal: nothing is pushed, so the old keys are retired as soon as it is signed.
			unlock, err := devtuf.Lock(*dir, time.Minute)
			if err != nil {
				return err
			}
			defer unlock()
			r, err := devtuf.Load(*dir, devtuf.Options{})
			if err != nil {
				return err
			}
			res, err := r.RotateTopLevel(opts)
			if err != nil {
				return err
			}
			if _, err := r.FinishRotation(); err != nil {
				return err
			}
			return printJSON(res)
		}
		p, err := publisher()
		if err != nil {
			return err
		}
		gh, res, err := p.Rotate(ctx, opts)
		if err != nil {
			if r, lerr := devtuf.Load(*dir, devtuf.Options{}); lerr == nil && r.RotationPending() {
				fmt.Fprintf(os.Stderr, "tufrepo: the ceremony isn't pushed yet: run the same gh-rotate again (its keys stay in %s); it carries on with what is signed, and the old root and targets keys stay online until GitHub has the new root\n", *offline)
			}
			return err
		}
		return printJSON(map[string]any{"github": gh, "ceremony": res})
	case "gh-clients-env":
		unlock, err := devtuf.Lock(*dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlock()
		r, err := devtuf.Load(*dir, devtuf.Options{})
		if err != nil {
			return err
		}
		if err := r.SetClientsEnv(*clientsEnv); err != nil {
			return err
		}
		return printJSON(map[string]string{"clientsEnv": r.ClientsEnv()})
	case "gh-clients":
		p, err := publisher()
		if err != nil {
			return err
		}
		res, err := p.UploadClients(ctx)
		if err != nil {
			return err
		}
		return printJSON(res)
	case "gh-resign":
		snap, err := devtuf.OnlineKey(*snapEnv)
		if err != nil {
			return err
		}
		ts, err := devtuf.OnlineKey(*tsEnv)
		if err != nil {
			return err
		}
		res, err := devtuf.ResignOnline(*metaDir, snap, ts, devtuf.ResignOptions{})
		if err != nil {
			return err
		}
		if err := printJSON(res); err != nil {
			return err
		}
		return reportSkipped(res.Skipped, *annotations)
	case "gh-expiry":
		var warn []int
		for _, s := range strings.Split(*warnDays, ",") {
			n, err := strconv.Atoi(strings.TrimSpace(s))
			if err != nil {
				return fmt.Errorf("--warn-days: %v", err)
			}
			warn = append(warn, n)
		}
		exp, err := devtuf.Expiries(*metaDir, time.Now())
		if err != nil {
			return err
		}
		last := 0
		for _, w := range warn {
			if last == 0 || w < last {
				last = w
			}
		}
		for _, e := range exp {
			line := fmt.Sprintf("%s version %d expires %s (%d days)", e.Role, e.Version, e.Expires.UTC().Format(time.RFC3339), e.DaysLeft)
			fmt.Println(line)
			if !*annotations {
				continue
			}
			for _, w := range warn {
				if e.DaysLeft <= w {
					level := "warning"
					if e.DaysLeft <= last {
						level = "error"
					}
					fmt.Printf("::%s title=TUF role %s expires in %d days::%s; re-sign it (%s)\n", level, e.Role, e.DaysLeft, line, resignHint(e.Role))
					break
				}
			}
		}
		return nil
	}
	return fmt.Errorf("unknown command %s", cmd)
}

// devtufKey is a private key as devtuf takes it.
type devtufKey = ed25519.PrivateKey

// resignHint says who signs a role again (LNK-25).
func resignHint(role string) string {
	switch role {
	case trust.ChannelDevelopment:
		return "the next development publish (the DEV candidate) re-signs it"
	case trust.ClientsRole:
		return "the AI client job re-signs it (release-tools/clients/latest-tested)"
	case trust.ChannelProduction:
		return "the next promotion re-signs it (tufrepo gh-promote; the production key is online with the publisher, ONE-05)"
	default:
		return "an offline signing: root and top-level targets keys are offline (the key ceremony, ONE-05)"
	}
}

// reportSkipped tells the workflow that gh-resign passed over a role file that didn't verify (signed with a wrong key, a
// broken push): what it signed is safe to serve (the role's last good version), but a promotion or release in that file
// never goes live, so the run must end red. With annotations, an error line per file; under GitHub Actions, the step's
// output `skipped` (their number), which the workflow's last job turns into a failed run after Pages is deployed.
func reportSkipped(skipped []string, annotations bool) error {
	if annotations {
		for _, s := range skipped {
			fmt.Printf("::error title=A role file didn't verify::%s; boxes keep the role's last good version until it is signed again\n", s)
		}
	}
	if out := os.Getenv("GITHUB_OUTPUT"); out != "" {
		f, err := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := fmt.Fprintf(f, "skipped=%d\n", len(skipped)); err != nil {
			return err
		}
	}
	return nil
}
