package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"rackoon/internal/agent/pkgs"
)

var packageTaskDirRe = regexp.MustCompile(`^pkg-[0-9a-f]{16}$`)

// cmdPackageTask runs one package task to its end (internal: the agent
// starts it through systemd-run, or in its own session without systemd;
// docs/MANAGE.md 2.9). SIGTERM stops a check; an install carries on.
func cmdPackageTask(args []string) error {
	fs := flag.NewFlagSet("package-task", flag.ExitOnError)
	dir := fs.String("dir", "", "the task's directory (<state dir>/packages/pkg-<hex>)")
	fs.Parse(args)
	if *dir == "" || !filepath.IsAbs(*dir) || !packageTaskDirRe.MatchString(filepath.Base(*dir)) {
		return errors.New("package-task needs --dir <state dir>/packages/pkg-<16 hex>")
	}
	spec, err := pkgs.ReadSpec(*dir)
	if err != nil {
		return err
	}
	if "pkg-"+strings.TrimPrefix(spec.ID, "pkg:") != filepath.Base(*dir) {
		return fmt.Errorf("the task in %s is %s", *dir, spec.ID)
	}
	signal.Ignore(syscall.SIGHUP)
	stop := make(chan struct{})
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	var once sync.Once
	go func() {
		for range sigs {
			once.Do(func() { close(stop) })
		}
	}()
	r := &pkgs.Runner{Dir: *dir, Stop: stop}
	return r.Run(context.Background())
}
