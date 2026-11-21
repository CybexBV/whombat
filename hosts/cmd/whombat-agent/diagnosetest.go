package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/diagnose"
	"rackoon/internal/proto"
)

// cmdDiagnoseTest runs the assistant's checks (or one root command) here,
// without a hub, for manual verification: what the hub's diagnose and exec
// streams would answer.
func cmdDiagnoseTest(args []string) error {
	fs := flag.NewFlagSet("diagnose-test", flag.ExitOnError)
	dir := fs.String("config-dir", "/etc/whombat-agent", "configuration directory")
	check := fs.String("check", "", "the check to run (none: the catalog)")
	var checkArgs argList
	fs.Var(&checkArgs, "arg", "check argument key=value; repeatable")
	command := fs.String("exec", "", "run this shell command as root instead (the assistant's exec)")
	timeout := fs.Int("timeout", 0, "exec: seconds (0 = the default)")
	asJSON := fs.Bool("json", false, "print the whole answer as JSON")
	level := fs.String("log-level", "warn", "log level")
	fs.Parse(args)
	log := newLogger(*level)
	cfg, err := loadOrDefaultConfig(*dir)
	if err != nil {
		return err
	}
	var d *diagnose.Diagnostics
	if runtime.GOOS == "darwin" {
		d = diagnose.NewMac(broker.NewMacBroker(cfg, log, nil).Inspect, log)
	} else {
		d = diagnose.New(broker.NewBroker(cfg, nil, log).Inspect, log)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	start := time.Now()
	if *command != "" {
		resp := d.Exec(ctx, proto.ExecRequest{Command: *command, TimeoutS: *timeout})
		if *asJSON {
			enc.Encode(resp)
		} else {
			fmt.Print(resp.Output)
			fmt.Fprintf(os.Stderr, "(exit %d, %d ms, timed out %v)\n", resp.ExitCode, resp.DurationMs, resp.TimedOut)
		}
		if resp.Code != "" {
			return fmt.Errorf("%s: %s", resp.Code, resp.Message)
		}
		return nil
	}
	name := *check
	if name == "" {
		name = proto.DiagnoseList
	}
	resp := d.Run(ctx, proto.DiagnoseRequest{Check: name, Args: checkArgs.m})
	switch {
	case *asJSON || name == proto.DiagnoseList:
		enc.Encode(resp)
	default:
		for _, c := range resp.Commands {
			fmt.Fprintln(os.Stderr, "$", c)
		}
		fmt.Print(resp.Output)
	}
	fmt.Fprintf(os.Stderr, "(%.1f s, truncated %v)\n", time.Since(start).Seconds(), resp.Truncated)
	if resp.Code != "" {
		return errors.New(resp.Code + ": " + resp.Message)
	}
	return nil
}
