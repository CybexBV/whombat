// Command whombat-vault-wall opens the Vault's home networks for the runtime server's uid, and nothing else
// (Whombat VT-59; IN-58…IN-61, NX-40). The runtime writes the admin's list to WHOMBAT_VAULT_NETWORKS_FILE; this
// daemon reads it without following links, validates it again, and replaces the elements of the egress table's
// two interval sets in one nft transaction. A missing or invalid file empties them.
//
//	whombat-vault-wall --file F --owner-uid N --nft PATH [--table "inet whombat-egress"] [--resync 60s]
//	whombat-vault-wall --flush --nft PATH [--table …]     empty both sets (ExecStopPost)
//	whombat-vault-wall --check FILE                       validate a file and print the transaction
//
// The unit runs it with CAP_NET_ADMIN only, as a dynamic user. SIGHUP (systemd reload, propagated from
// nftables.service) re-applies the list; so does every --resync.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/vaultwall/internal/networks"
	"github.com/CybexBV/whombat/appliance/vaultwall/internal/wall"
)

func main() {
	file := flag.String("file", "", "the runtime's list (WHOMBAT_VAULT_NETWORKS_FILE)")
	owner := flag.Int("owner-uid", -1, "uid that may own the file and its directory besides root (the runtime's user)")
	nft := flag.String("nft", "nft", "the nft binary")
	table := flag.String("table", "inet whombat-egress", "the table holding the sets")
	set4 := flag.String("set4", "vault4", "the IPv4 set (ipv4_addr . inet_service, interval)")
	set6 := flag.String("set6", "vault6", "the IPv6 set (ipv6_addr . inet_service, interval)")
	resync := flag.Duration("resync", time.Minute, "re-apply the list this often")
	flush := flag.Bool("flush", false, "empty both sets and exit")
	check := flag.String("check", "", "validate this file, print the nft transaction and exit (1: invalid)")
	flag.Parse()

	sets := wall.Sets{Table: *table, Set4: *set4, Set6: *set6}
	switch {
	case *check != "":
		data, err := os.ReadFile(*check)
		if err == nil {
			var nets []networks.Network
			if nets, err = networks.Parse(data); err == nil {
				fmt.Print(sets.Script(networks.Elements(nets)))
				return
			}
		}
		fmt.Fprintln(os.Stderr, "whombat-vault-wall:", err)
		os.Exit(1)
	case *flush:
		if err := (wall.NFT{Path: *nft}).Apply(sets.Script(nil, nil)); err != nil {
			fmt.Fprintln(os.Stderr, "whombat-vault-wall:", err)
			os.Exit(1)
		}
		return
	}

	if *file == "" || *owner < 0 || *resync < time.Second {
		fmt.Fprintln(os.Stderr, "whombat-vault-wall: --file, --owner-uid and a --resync of at least 1s are required")
		os.Exit(2)
	}
	src, err := wall.NewSource(*file, uint32(*owner), networks.MaxFileBytes)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-vault-wall:", err)
		os.Exit(2)
	}
	w := &wall.Wall{
		Source: src,
		Sets:   sets,
		Apply:  wall.NFT{Path: *nft}.Apply,
		Log: func(msg string) {
			fmt.Fprintln(os.Stderr, msg)
			notify("STATUS=" + msg)
		},
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	reload := make(chan struct{}, 1)
	go func() {
		for range hup {
			select {
			case reload <- struct{}{}:
			default:
			}
		}
	}()
	if err := w.Run(ctx, *resync, reload, func() { notify("READY=1\nSTATUS=" + w.Status()) }); err != nil {
		fmt.Fprintln(os.Stderr, "whombat-vault-wall:", err)
		os.Exit(1)
	}
	notify("STOPPING=1")
}

// notify sends a state to systemd ($NOTIFY_SOCKET); a no-op outside systemd.
func notify(state string) {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return
	}
	if path[0] == '@' {
		path = "\x00" + path[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}
