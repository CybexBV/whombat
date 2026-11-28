package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"rackoon/internal/agent/apps"
)

var appTaskDirRe = regexp.MustCompile(`^app-[0-9a-f]{16}$`)

// cmdAppTask runs one app task to its end (internal: the agent starts it
// through systemd-run, or in its own session without systemd; docs/MANAGE.md
// 2.11). It doesn't stop when asked: an app half updated is worse than a
// slow update, and each app goes back by itself when it fails.
func cmdAppTask(args []string) error {
	fs := flag.NewFlagSet("app-task", flag.ExitOnError)
	dir := fs.String("dir", "", "the task's directory (<state dir>/apps/app-<hex>)")
	fs.Parse(args)
	if *dir == "" || !filepath.IsAbs(*dir) || !appTaskDirRe.MatchString(filepath.Base(*dir)) {
		return errors.New("app-task needs --dir <state dir>/apps/app-<16 hex>")
	}
	spec, err := apps.ReadSpec(*dir)
	if err != nil {
		return err
	}
	if "app-"+strings.TrimPrefix(spec.ID, "app:") != filepath.Base(*dir) {
		return fmt.Errorf("the task in %s is %s", *dir, spec.ID)
	}
	signal.Ignore(syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	r := &apps.Runner{Dir: *dir}
	return r.Run(context.Background())
}
