// Command clientchannel builds and publishes the signed AI client channel (CT-74, SUB-09; runbook
// docs/runbooks/updates.md, “AI client channel”). It publishes into a DEVELOPMENT TUF repository (the dev instance's); production
// hands the same signed documents to the release publishing service.
//
//	clientchannel latest  --provider claude                             print upstream's latest release
//	clientchannel fetch   --provider claude --version V [--arch x86_64] --dir D  download the official artifact, check
//	        the vendor digest, print a Fetched JSON (with every platform's pins for Whombat's bundles.ts)
//	clientchannel bundle  --fetched F.json --fixtures-digest sha256:… --adapter N|MIN-MAX [--tested-at RFC3339]
//	        --work D --out B.json                                        build the bundle and its artifact
//	clientchannel publish --repo R [--key-file K] [--bundle B.json]… [--withdraw provider/version]… [--lifetime 168h]
//	        [--keep 4]                                                   sign and publish a new channel
//	clientchannel refresh --repo R [--key-file K] [--within 96h]      re-sign when the channel expires within --within
//	clientchannel show    --repo R                                      print the published channel
//	clientchannel mirror  --from S --repo R [--key-file K]              make R's channel S's, byte for byte (the GitHub
//	        repository beside DEV's: the same sequence, so a box that moves keeps it); R's role signed, not pushed
//	        (tufrepo gh-clients does that)
//
// Claude Code only: Codex is no longer followed or fetched (ChatGPT runs on Hermes's own provider, IN-432); bundles
// already published for it stay in the channel until withdrawn (`publish --withdraw codex/<version>`).
//
// publish, refresh and show also run against the PRODUCTION repository of the pilot (PI-05, PI-17) with all of
// --env prod --custody online-pilot --keys-dir /etc/whombat/secrets/tuf: the clients key is the one in the keys
// directory that holds the clients role, and --key-file (a development key file) is refused. Development and
// production never mix, as in tufrepo (MA-14).
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/clientchannel"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: clientchannel latest|fetch|bundle|publish|refresh|show|mirror [flags] (see source header)")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "clientchannel:", err)
		os.Exit(1)
	}
}

func printJSON(v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(b))
	return err
}

func parseAdapter(s string) (release.IntRange, error) {
	lo, hi, ok := strings.Cut(s, "-")
	if !ok {
		hi = lo
	}
	a, err1 := strconv.ParseInt(lo, 10, 64)
	b, err2 := strconv.ParseInt(hi, 10, 64)
	if err1 != nil || err2 != nil || a < 1 || b < a {
		return release.IntRange{}, fmt.Errorf("--adapter %q: N or MIN-MAX with 1 <= MIN <= MAX", s)
	}
	return release.IntRange{Min: a, Max: b}, nil
}

// repoOptions turns --env/--custody/--keys-dir into devtuf options: none of them for a development repository, all
// three for the production pilot's (tufrepo's rule, MA-14).
func repoOptions(env, custody, keysDir string) (devtuf.Options, error) {
	if env == "" && custody == "" && keysDir == "" {
		return devtuf.Options{}, nil
	}
	if env != "prod" || custody != devtuf.CustodyOnlinePilot || keysDir == "" {
		return devtuf.Options{}, fmt.Errorf("production needs all of --env prod --custody %s --keys-dir DIR (PI-05); development repositories take none of them", devtuf.CustodyOnlinePilot)
	}
	return devtuf.Options{Env: env, Custody: custody, KeysDir: keysDir}, nil
}

// openRepo locks the repository (the caller unlocks when done: each command is one process) and loads it.
func openRepo(dir, keyFile string, opts devtuf.Options) (_ *devtuf.Repo, _ ed25519.PrivateKey, _ func(), err error) {
	if dir == "" {
		return nil, nil, nil, errors.New("--repo is required")
	}
	if opts.Custody != "" && keyFile != "" {
		return nil, nil, nil, errors.New("--key-file names a development key file; production keys live in --keys-dir")
	}
	unlock, err := devtuf.Lock(dir, 5*time.Minute)
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() {
		if err != nil {
			unlock()
		}
	}()
	r, err := devtuf.Load(dir, opts)
	if err != nil {
		return nil, nil, nil, err
	}
	if !r.HasClientsRole() {
		return nil, nil, nil, fmt.Errorf("%s has no clients role (tufrepo add-clients-role --dir %s)", dir, dir)
	}
	if keyFile == "" {
		return r, nil, unlock, nil
	}
	role, seed, err := devtuf.LoadKeyFile(keyFile)
	if err != nil {
		return nil, nil, nil, err
	}
	if role != trust.ClientsRole {
		return nil, nil, nil, fmt.Errorf("%s is a %q key", keyFile, role)
	}
	return r, ed25519.NewKeyFromSeed(seed), unlock, nil
}

func run(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	provider := fs.String("provider", "", "claude (Codex is no longer published, IN-432)")
	version := fs.String("version", "", "upstream version")
	arch := fs.String("arch", "x86_64", "x86_64|aarch64")
	dir := fs.String("dir", "", "download directory")
	fetched := fs.String("fetched", "", "Fetched JSON (from fetch)")
	fixtures := fs.String("fixtures-digest", "", "sha256:<hex> of the regenerated provider fixture")
	adapter := fs.String("adapter", "", "adapter level(s) the tests passed with: N or MIN-MAX")
	testedAt := fs.String("tested-at", "", "RFC 3339 (default now)")
	work := fs.String("work", "", "work directory for the artifact")
	out := fs.String("out", "", "output file")
	repo := fs.String("repo", "", "development TUF repository")
	keyFile := fs.String("key-file", "", "clients role key file (default: the repository's own development key)")
	from := fs.String("from", "", "mirror: the repository whose channel is mirrored")
	var bundles, withdraw multi
	fs.Var(&bundles, "bundle", "bundle JSON (from bundle); repeatable")
	fs.Var(&withdraw, "withdraw", "provider/version to withdraw; repeatable")
	lifetime := fs.Duration("lifetime", 7*24*time.Hour, "channel lifetime (at most 336h)")
	keep := fs.Int("keep", 4, "bundles kept per provider and architecture")
	within := fs.Duration("within", 96*time.Hour, "refresh: re-sign when the channel expires within this")
	env := fs.String("env", "", "production only: prod (with --custody and --keys-dir)")
	custody := fs.String("custody", "", "production key custody: online-pilot (PI-05)")
	keysDir := fs.String("keys-dir", "", "production private keys directory (absolute, 0700, outside --repo)")
	fs.Parse(args)
	opts, err := repoOptions(*env, *custody, *keysDir)
	if err != nil {
		return err
	}
	ctx := context.Background()
	up := clientchannel.HTTP{}

	switch cmd {
	case "latest":
		v, err := up.Latest(ctx, release.ClientProvider(*provider))
		if err != nil {
			return err
		}
		fmt.Println(v)
		return nil
	case "fetch":
		if *version == "" || *dir == "" {
			return errors.New("--version and --dir are required")
		}
		f, err := up.Fetch(ctx, release.ClientProvider(*provider), *version, release.ClientArch(*arch), *dir)
		if err != nil {
			return err
		}
		return printJSON(f)
	case "bundle":
		b, err := os.ReadFile(*fetched)
		if err != nil {
			return err
		}
		var f clientchannel.Fetched
		if err := json.Unmarshal(b, &f); err != nil {
			return err
		}
		ad, err := parseAdapter(*adapter)
		if err != nil {
			return err
		}
		tested := time.Now().UTC()
		if *testedAt != "" {
			if tested, err = time.Parse(time.RFC3339, *testedAt); err != nil {
				return err
			}
		}
		built, err := clientchannel.Build(ctx, clientchannel.Input{Provider: f.Provider, Version: f.Version, Arch: f.Arch,
			PublishedAt: f.PublishedAt, TestedAt: tested, FixturesDigest: *fixtures, Adapter: ad, SourceURL: f.URL,
			SourceFile: f.File, SourceFormat: f.Format, SourcePath: f.Path, ExpectSourceSHA256: f.SHA256}, *work)
		if err != nil {
			return err
		}
		data, _ := json.MarshalIndent(built, "", " ")
		if *out == "" {
			fmt.Println(string(data))
			return nil
		}
		return os.WriteFile(*out, append(data, '\n'), 0o644)
	case "publish", "refresh":
		r, key, unlock, err := openRepo(*repo, *keyFile, opts)
		if err != nil {
			return err
		}
		defer unlock()
		p := &clientchannel.Publisher{Repo: r, Key: key, Lifetime: *lifetime, Keep: *keep}
		var add []clientchannel.Built
		for _, path := range bundles {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			var built clientchannel.Built
			if err := json.Unmarshal(b, &built); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			if err := built.Bundle.Validate(); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			add = append(add, built)
		}
		if cmd == "refresh" {
			cur, err := p.Current()
			if err != nil {
				return err
			}
			if cur != nil && time.Unix(cur.Payload.ExpiresAt, 0).After(time.Now().Add(*within)) {
				fmt.Printf("channel %d valid until %s; nothing to do\n", cur.Payload.Sequence, time.Unix(cur.Payload.ExpiresAt, 0).UTC().Format(time.RFC3339))
				return nil
			}
		}
		ch, err := p.Publish(add, withdraw)
		if err != nil {
			return err
		}
		fmt.Printf("published client channel %d (%d bundles, expires %s)\n", ch.Payload.Sequence, len(ch.Payload.Bundles),
			time.Unix(ch.Payload.ExpiresAt, 0).UTC().Format(time.RFC3339))
		for _, b := range ch.Payload.Bundles {
			fmt.Printf("  %s %s linux-%s adapter %d-%d executable %s\n", b.Provider, b.Version, b.Arch, b.Adapter.Min, b.Adapter.Max, b.Executable.SHA256)
		}
		return nil
	case "mirror":
		if *from == "" {
			return errors.New("--from is required")
		}
		unlockFrom, err := devtuf.Lock(*from, 5*time.Minute)
		if err != nil {
			return err
		}
		defer unlockFrom()
		src, err := devtuf.Load(*from, devtuf.Options{})
		if err != nil {
			return err
		}
		r, key, unlock, err := openRepo(*repo, *keyFile, opts)
		if err != nil {
			return err
		}
		defer unlock()
		ch, changed, err := clientchannel.Mirror(src, r, key, time.Now())
		if err != nil {
			return err
		}
		if !changed {
			fmt.Printf("client channel %d is there already\n", ch.Payload.Sequence)
			return nil
		}
		fmt.Printf("mirrored client channel %d (%d bundles) into %s\n", ch.Payload.Sequence, len(ch.Payload.Bundles), *repo)
		return nil
	case "show":
		if *repo == "" {
			return errors.New("--repo is required")
		}
		r, err := devtuf.Load(*repo, opts)
		if err != nil {
			return err
		}
		cur, err := (&clientchannel.Publisher{Repo: r}).Current()
		if err != nil {
			return err
		}
		if cur == nil {
			return errors.New("no client channel published")
		}
		return printJSON(cur)
	}
	return fmt.Errorf("unknown command %q", cmd)
}
