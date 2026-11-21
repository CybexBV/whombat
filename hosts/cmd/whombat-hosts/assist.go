package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"rackoon/internal/assist"
	"rackoon/internal/hub"
)

// assistCmd is `whombat-hosts assist serve|mcp-bridge`: the assistant's
// runner (docs/ASSIST.md). systemd starts `serve` for each connection to
// rackoon-assist.socket with the connection as stdin and stdout; without
// the socket the hub starts it as a child process on pipes. The CLIs start
// `mcp-bridge` as their MCP server.
func assistCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: whombat-hosts assist serve [--state DIR] | mcp-bridge | call [--socket PATH] METHOD [JSON]")
	}
	switch args[0] {
	case "serve":
		fs := flag.NewFlagSet("assist serve", flag.ExitOnError)
		state := fs.String("state", env("ASSIST_STATE", "/var/lib/rackoon-assist"), "state directory: CLIs, their sign-ins and sessions [WHOMBAT_HOSTS_ASSIST_STATE]")
		_ = fs.Parse(args[1:])
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer stop()
		return assist.Serve(ctx, stdio{}, assist.Options{StateDir: *state, Exe: exe, Version: hub.Version, Log: log,
			Sandboxed: os.Getenv("ASSIST_SANDBOX") == "1"})
	case "mcp-bridge":
		return assist.Bridge(os.Stdin, os.Stdout)
	case "call":
		return assistCall(args[1:])
	}
	return fmt.Errorf("unknown assist command %q", args[0])
}

// stdio is the runner's connection to the hub.
type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (stdio) Close() error {
	os.Stdin.Close()
	return os.Stdout.Close()
}

// assistCall is `whombat-hosts assist call METHOD [JSON]`: one request to the
// runner's socket, for debugging (status, latest, install, ...). It prints
// the runner's notifications while it waits.
func assistCall(args []string) error {
	fs := flag.NewFlagSet("assist call", flag.ExitOnError)
	sock := fs.String("socket", env("ASSIST_SOCKET", "/run/rackoon-assist.sock"), "the runner's socket [WHOMBAT_HOSTS_ASSIST_SOCKET]")
	timeout := fs.Duration("timeout", 30*time.Minute, "how long to wait for the answer")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		return errors.New("usage: whombat-hosts assist call [--socket PATH] METHOD [JSON]")
	}
	var params json.RawMessage
	if fs.NArg() > 1 {
		params = json.RawMessage(fs.Arg(1))
	}
	c, err := net.Dial("unix", *sock)
	if err != nil {
		return err
	}
	p := assist.NewPeer(c, func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		return assist.ToolResult{Text: "no hub here", IsError: true}, nil
	}, func(method string, raw json.RawMessage) { fmt.Fprintf(os.Stderr, "%s %s\n", method, raw) })
	p.Start()
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	var out json.RawMessage
	if err := p.Call(ctx, fs.Arg(0), params, &out); err != nil {
		return err
	}
	fmt.Println(string(out))
	return nil
}
