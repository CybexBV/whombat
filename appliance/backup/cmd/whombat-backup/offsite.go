package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/offsite"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// cmdOffsite is the second place: a copy of the backups somewhere else.
//
//	offsite status [-json]
//	offsite set -provider b2|r2|hetzner|aws|s3 -repository s3:https://host/bucket/folder -s3-key-id ID -s3-secret-file F [-s3-region R]
//	offsite remove
//	offsite copy [-if-due]     the 15-minute timer and the path unit run it with -if-due
func cmdOffsite(ctx context.Context, cfg *state.Config, args []string) {
	if len(args) == 0 {
		die(64, "offsite status|set|remove|copy")
	}
	fs := flag.NewFlagSet("offsite", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "JSON")
	provider := fs.String("provider", "s3", "b2, r2, hetzner, aws or s3")
	repo := fs.String("repository", "", "s3:https://host/bucket/folder (or a local path: tests)")
	s3ID := fs.String("s3-key-id", "", "S3 access key ID")
	s3Secret := fs.String("s3-secret-file", "", "file with the S3 secret access key")
	s3Region := fs.String("s3-region", "", "S3 region (when the service needs one)")
	ifDue := fs.Bool("if-due", false, "only when a copy is due (the timer)")
	_ = fs.Parse(args[1:])
	switch args[0] {
	case "status":
		d := offsite.Doc(cfg)
		if *asJSON {
			printJSON(d)
			return
		}
		if !d.Configured {
			fmt.Println("second place: none")
			return
		}
		fmt.Printf("second place: %s (%s), %s\n", d.Display, d.Provider, d.State)
		if lc := d.LastCopy; lc != nil {
			fmt.Printf("last copy: %s, newest backup in it %s\n", lc.At.Format(time.RFC3339), lc.CheckpointID)
		}
		if f := d.LastFailure; f != nil {
			fmt.Printf("last failure (%d in a row): %s at %s: %s\n", d.FailedAttempts, f.Step, f.At.Format(time.RFC3339), f.Reason)
		}
	case "set":
		p, err := offsite.Set(ctx, cfg, offsite.Request{Provider: *provider, Repository: *repo, S3AccessKeyID: *s3ID,
			S3SecretAccessKey: readSecret(*s3Secret), S3Region: *s3Region, AllowLocal: true})
		if err != nil {
			die(1, "%v", err)
		}
		fmt.Printf("second place %s: repository %s — the first copy starts now; issue a new recovery kit\n", p.Display(), p.RepositoryID)
	case "remove":
		if err := offsite.Remove(cfg); err != nil {
			die(1, "%v", err)
		}
		fmt.Println("second place removed (the copies there stay)")
	case "copy":
		if *ifDue {
			if due, why := offsite.Due(cfg, time.Now()); !due {
				logf("offsite: not due: %s", why)
				return
			} else {
				logf("offsite: due: %s", why)
			}
		}
		res, err := offsite.Copy(ctx, cfg, logf)
		switch {
		case errors.Is(err, offsite.ErrBusy):
			die(3, "%v", err)
		case errors.Is(err, offsite.ErrNotSet):
			if *ifDue {
				return
			}
			die(2, "%v", err)
		case err != nil:
			die(1, "%v", err)
		}
		fmt.Printf("copied %d backups to the second place\n", res.Copied)
	default:
		die(64, "offsite status|set|remove|copy")
	}
}
