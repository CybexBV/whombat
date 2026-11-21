// Command whombat-kiosk-udev passes udevd's input device events into the kiosk's network namespace (NX-400…NX-404).
// The kiosk's cage runs in the console server's private namespace (NX-82), where udevd's messages never arrive, so it
// never used a keyboard or mouse that appeared after it started (a Bluetooth keyboard at every connection, NX-360);
// with the relay, libinput adds it as it would anywhere.
//
//	whombat-kiosk-udev [--subsystems input]
//
// systemd hands it two sockets of the uevent netlink family: `host`, made in the host's namespace and bound to udevd's
// group (whombat-kiosk-udev-host.socket), and `kiosk`, made in the console server's namespace
// (whombat-kiosk-udev-kiosk.socket). It reads only the first and sends only from the second; it makes no socket of its
// own. The unit runs it as root (libudev believes messages from uid 0) with CAP_NET_ADMIN alone (sending to a group of
// this family needs it).
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/appliance/kioskudev/internal/relay"
)

func main() {
	subsystems := flag.String("subsystems", "input", "comma-separated subsystems whose events are passed")
	flag.Parse()

	host, kiosk, err := sockets()
	if err != nil {
		fail(err)
	}
	if err := relay.Check(host, kiosk); err != nil {
		fail(err)
	}
	r := &relay.Relay{
		From:       host,
		To:         kiosk,
		Subsystems: strings.Split(*subsystems, ","),
		Log:        func(s string) { fmt.Fprintln(os.Stderr, s) },
	}
	fmt.Fprintf(os.Stderr, "passing udev's %s events into the kiosk's network namespace\n", strings.Join(r.Subsystems, ", "))
	fail(r.Run())
}

// sockets are systemd's, by their names (FileDescriptorName=).
func sockets() (host, kiosk *os.File, err error) {
	if os.Getenv("LISTEN_PID") != strconv.Itoa(os.Getpid()) {
		return nil, nil, errors.New("no sockets from systemd (LISTEN_PID isn't this process)")
	}
	n, err := strconv.Atoi(os.Getenv("LISTEN_FDS"))
	names := strings.Split(os.Getenv("LISTEN_FDNAMES"), ":")
	if err != nil || n != len(names) {
		return nil, nil, fmt.Errorf("LISTEN_FDS=%q doesn't match LISTEN_FDNAMES=%q", os.Getenv("LISTEN_FDS"), os.Getenv("LISTEN_FDNAMES"))
	}
	for _, v := range []string{"LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"} {
		os.Unsetenv(v)
	}
	for i, name := range names {
		switch name {
		case "host":
			host = os.NewFile(uintptr(3+i), name)
		case "kiosk":
			kiosk = os.NewFile(uintptr(3+i), name)
		}
	}
	if host == nil || kiosk == nil {
		return nil, nil, fmt.Errorf("systemd's sockets are %q, not host and kiosk", names)
	}
	return host, kiosk, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "whombat-kiosk-udev:", err)
	os.Exit(1)
}
