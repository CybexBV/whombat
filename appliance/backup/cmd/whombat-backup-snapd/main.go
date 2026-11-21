// Command whombat-backup-snapd is the backup's snapshot helper (BK-04): a root, socket-activated service
// with two typed operations — take and release the checkpoint's source snapshots — for exactly one peer,
// the whombat-backup user. Sources, driver and destinations come from its own configuration; a request
// names only a checkpoint id.
//
//	whombat-backup-snapd [-config /etc/whombat-backup/config.json] [-socket PATH]
package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func main() {
	cfgPath := flag.String("config", "/etc/whombat-backup/config.json", "configuration file")
	socket := flag.String("socket", "/run/whombat-backup/snapd.sock", "unix socket (ignored under socket activation)")
	flag.Parse()
	cfg, err := state.LoadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(78)
	}
	if cfg.BackupUID < 0 {
		fmt.Fprintln(os.Stderr, "backupUid is not configured: refusing to serve anyone")
		os.Exit(78)
	}
	var d snap.Driver
	switch cfg.Driver {
	case "btrfs":
		d = snap.Btrfs{}
	case "zfs":
		d = snap.ZFS{Datasets: cfg.SnapDatasets, Tag: "whombat-backup"}
	default:
		d = snap.Copy{Reserve: cfg.ReserveBytes}
	}
	var l net.Listener
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == fmt.Sprint(os.Getpid()) {
		l, err = net.FileListener(os.NewFile(3, "socket"))
	} else {
		_ = os.Remove(*socket)
		l, err = net.Listen("unix", *socket)
		if err == nil {
			_ = os.Chmod(*socket, 0o660)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	srv := &snap.Server{Local: &snap.Local{Driver: d, Sources: cfg.Layout().Sources(),
		FilesDir: filepath.Join(cfg.StagingDir(), "files")}, AllowedUID: cfg.BackupUID}
	if err := srv.Serve(l); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
