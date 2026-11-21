// Command whombat-installer-ui is the graphical installer's server on the installer ISO (CG-11…CG-14, NX-79): as
// root, it serves the web app (installer mode) and the Installer API on a loopback address for the kiosk on tty1,
// runs the pre-flight checks, lists the disks, runs whombat-install for the chosen disk and follows its progress,
// and restarts the machine at the end. The API token is made at every start and written to --token-file (0640,
// its directory's group is the kiosk's). Without a cable that has an address, the page offers a Wi-Fi step (HD-08,
// CG-120): /api/wifi… scan and join with the machine's Wi-Fi card, and the install copies the joined network's profile
// into the system (whombat-install --wifi-profile). The page asks how the owner will reach the box (Whombat Link or
// Tailscale or Headscale, LNK-12, ONE-12) and passes it on (whombat-install --reach). It installs the image's own
// environment, production: there is no developer option (ONE-02).
//
//	whombat-installer-ui --serve 127.0.0.1:8412 --ui DIR --token-file F --system /nix/store/…-toplevel
//	                     [--medium-label WHOMBAT-INSTALLER] [--install-cmd whombat-install] [--lsblk lsblk]
//	whombat-installer-ui --state --system S   (the pre-flight once, as JSON on stdout; no server)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/installer"
	"github.com/CybexBV/whombat/appliance/console/internal/source"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

func main() {
	serve := flag.String("serve", "127.0.0.1:8412", "loopback address to serve on")
	uiDir := flag.String("ui", "", "the UI's static files")
	tokenFile := flag.String("token-file", "", "where the per-start API token goes (0640)")
	system := flag.String("system", "", "the system the installer puts on the disk (reads <system>/etc/whombat/image.json)")
	mediumLabel := flag.String("medium-label", "WHOMBAT-INSTALLER", "file system label of the installer medium (never offered)")
	installCmd := flag.String("install-cmd", "whombat-install", "the installer command (--disk D --yes-erase-disk are appended)")
	lsblk := flag.String("lsblk", "lsblk", "lsblk")
	reboot := flag.String("reboot-cmd", "systemctl reboot", "how to restart")
	stateOnly := flag.Bool("state", false, "run the pre-flight checks once and print the state as JSON")
	checkDisk := flag.String("check-disk", "", "check a whole disk is safe to erase, without starting the UI")
	minDisk := flag.Int64("minimum-disk-bytes", installer.MinDiskBytes, "minimum size for --check-disk")
	flag.Parse()
	if *checkDisk != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		path, err := filepath.EvalSymlinks(*checkDisk)
		if err == nil {
			var data []byte
			data, err = (installer.Machine{Lsblk: *lsblk}).BlockDevices(ctx)
			if err == nil {
				err = installer.CheckDisk(data, path, *mediumLabel, *minDisk)
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "whombat-installer-ui:", err)
			os.Exit(1)
		}
		return
	}

	if err := run(*serve, *uiDir, *tokenFile, *system, *mediumLabel, *installCmd, *lsblk, *reboot, *stateOnly); err != nil {
		fmt.Fprintln(os.Stderr, "whombat-installer-ui:", err)
		os.Exit(1)
	}
}

func run(addr, uiDir, tokenFile, system, mediumLabel, installCmd, lsblk, reboot string, stateOnly bool) error {
	if system == "" {
		return fmt.Errorf("--system is required")
	}
	// A link into the store inside the system's etc (the store is the image's own, read-only).
	target, err := filepath.EvalSymlinks(filepath.Join(system, "etc/whombat/image.json"))
	if err != nil {
		return fmt.Errorf("image.json: %w", err)
	}
	data, err := source.ReadLimited(target, 4097)
	if err != nil {
		return fmt.Errorf("image.json: %w", err)
	}
	image, err := installer.ParseImage(data)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	sys := installer.Machine{Lsblk: lsblk, InstallCmd: strings.Fields(installCmd), RebootCmd: strings.Fields(reboot), Log: os.Stderr}
	// The Wi-Fi card: iwd on the system bus (helper/pkg/wifi); without iwd or a card the page says so.
	srv := installer.New(ctx, image, mediumLabel, sys).WithWifi(installer.NewIWD())
	srv.StartPreflight()
	if stateOnly {
		for srv.State().Preflight.Status != "done" {
			time.Sleep(100 * time.Millisecond)
		}
		b, _ := json.MarshalIndent(srv.State(), "", "  ")
		fmt.Println(string(b))
		return nil
	}
	if uiDir == "" || tokenFile == "" {
		return fmt.Errorf("--ui and --token-file are required")
	}
	if st, err := os.Stat(uiDir); err != nil || !st.IsDir() {
		return fmt.Errorf("--ui %s: not a directory", uiDir)
	}
	ln, port, err := web.Listen(addr)
	if err != nil {
		return err
	}
	token, err := web.NewToken()
	if err != nil {
		return err
	}
	if err := web.WriteTokenFile(tokenFile, token); err != nil {
		return fmt.Errorf("token file: %w", err)
	}
	defer os.Remove(tokenFile)
	h := web.Handler(web.Options{Port: port, Token: token, UI: os.DirFS(uiDir), API: srv.Handler(), MaxBody: 4096})
	_ = web.Notify("READY=1\nSTATUS=serving the installer on " + ln.Addr().String())
	return web.Serve(ctx, ln, h)
}
