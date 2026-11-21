// Package relay passes udevd's device events from the host's network namespace into the kiosk's (NX-400).
//
// libudev's monitors listen on group 2 of the uevent netlink family, where udevd sends every device it has finished
// (its node made, its rules applied); the kernel delivers those messages only inside the sender's network namespace.
// The kiosk's cage runs in the console server's private namespace (NX-82), so its libinput never heard of a keyboard
// or a mouse that appeared after it started. The relay reads udevd's messages from a socket made in the host's
// namespace, keeps those of the chosen subsystems, and sends the same bytes to group 2 from a socket made in the
// kiosk's, where libudev takes them as udevd's own: it believes a sender of uid 0, and the bytes are udevd's.
package relay

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	// GroupUdev is udevd's multicast group (systemd's MONITOR_GROUP_UDEV; the kernel's own uevents are group 1).
	GroupUdev = 2
	// udevMask is the group as struct sockaddr_nl names it (a bit mask: group n is bit n-1).
	udevMask = 1 << (GroupUdev - 1)
	// headerSize is systemd's struct monitor_netlink_header: "libudev\0", the magic, the header's size, the
	// properties' offset and length, two hashes and a bloom filter (4 bytes each after the prefix).
	headerSize = 40
	magic      = 0xfeedcafe
	// MaxMessage is the longest message passed (an input device's is 1–2 KiB); a longer one is dropped.
	MaxMessage = 64 << 10
)

// Event is what the relay reads from a message: enough to choose and to log. Never the device's name or its
// Bluetooth address, which the properties carry too (BT-10).
type Event struct {
	Action    string
	Subsystem string
	// DevName is the device's node (/dev/input/event7), "" for one without (input7).
	DevName string
}

// Parse reads a message of udevd's group as libudev does: the "libudev" header with its magic (big-endian), then the
// properties, KEY=value strings each ending in NUL, at the header's offset.
func Parse(msg []byte) (Event, error) {
	var e Event
	if len(msg) < headerSize {
		return e, errors.New("shorter than libudev's header")
	}
	if string(msg[:8]) != "libudev\x00" {
		return e, errors.New("not a libudev message")
	}
	if binary.BigEndian.Uint32(msg[8:12]) != magic {
		return e, errors.New("not libudev's magic")
	}
	off, n := binary.NativeEndian.Uint32(msg[16:20]), binary.NativeEndian.Uint32(msg[20:24])
	if off < headerSize || n == 0 || uint64(off)+uint64(n) > uint64(len(msg)) {
		return e, errors.New("the properties are outside the message")
	}
	for kv := range bytes.SplitSeq(msg[off:off+n], []byte{0}) {
		k, v, ok := bytes.Cut(kv, []byte{'='})
		if !ok {
			continue
		}
		switch string(k) {
		case "ACTION":
			e.Action = string(v)
		case "SUBSYSTEM":
			e.Subsystem = string(v)
		case "DEVNAME":
			e.DevName = string(v)
		}
	}
	if e.Action == "" || e.Subsystem == "" {
		return e, errors.New("no ACTION or SUBSYSTEM")
	}
	return e, nil
}

// errOther is a message of a subsystem the relay doesn't pass: the usual case, not logged.
var errOther = errors.New("another subsystem")

// Relay passes the messages of Subsystems from From (the host's namespace, bound to GroupUdev) to GroupUdev of To
// (the kiosk's namespace, bound to no group). Both come from systemd; the relay makes no socket.
type Relay struct {
	From, To   *os.File
	Subsystems []string
	// Log gets a line per device node passed and per message dropped for a reason other than its subsystem.
	Log func(string)
}

// Check refuses sockets the relay can't work with: not of the uevent family, the host's socket not on udevd's
// group, the kiosk's on any group, or both in one network namespace (the relay would then hear its own messages and
// pass them again). It turns on the sender's credentials on the host's socket (libudev's first test, and the relay's).
func Check(host, kiosk *os.File) error {
	var hostNS, kioskNS unix.Stat_t
	for _, s := range []struct {
		f      *os.File
		groups uint32
		ns     *unix.Stat_t
	}{{host, udevMask, &hostNS}, {kiosk, 0, &kioskNS}} {
		err := control(s.f, func(fd int) error {
			if d, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_DOMAIN); err != nil || d != unix.AF_NETLINK {
				return fmt.Errorf("not a netlink socket (%v)", err)
			}
			if p, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_PROTOCOL); err != nil || p != unix.NETLINK_KOBJECT_UEVENT {
				return fmt.Errorf("not of the uevent family (%v)", err)
			}
			sa, err := unix.Getsockname(fd)
			if err != nil {
				return err
			}
			nl, ok := sa.(*unix.SockaddrNetlink)
			if !ok {
				return errors.New("no netlink address")
			}
			if nl.Groups != s.groups {
				return fmt.Errorf("bound to the groups %#x, not %#x", nl.Groups, s.groups)
			}
			ns, err := unix.IoctlRetInt(fd, unix.SIOCGSKNS)
			if err != nil {
				return fmt.Errorf("its network namespace: %w", err)
			}
			defer unix.Close(ns)
			return unix.Fstat(ns, s.ns)
		})
		if err != nil {
			return fmt.Errorf("socket %s: %w", s.f.Name(), err)
		}
	}
	if hostNS.Dev == kioskNS.Dev && hostNS.Ino == kioskNS.Ino {
		return errors.New("both sockets are in one network namespace")
	}
	return control(host, func(fd int) error { return unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_PASSCRED, 1) })
}

// Run passes messages until a socket fails; it returns the error. A message it can't send is logged and dropped,
// except when it may not send at all (no CAP_NET_ADMIN), which ends it.
func (r *Relay) Run() error {
	from, err := r.From.SyscallConn()
	if err != nil {
		return err
	}
	to, err := r.To.SyscallConn()
	if err != nil {
		return err
	}
	buf := make([]byte, MaxMessage+1)
	oob := make([]byte, unix.CmsgSpace(unix.SizeofUcred))
	for {
		var n, oobn, flags int
		var sa unix.Sockaddr
		var rerr error
		if err := from.Read(func(fd uintptr) bool {
			n, oobn, flags, sa, rerr = unix.Recvmsg(int(fd), buf, oob, 0)
			return rerr != unix.EAGAIN
		}); err != nil {
			return err
		}
		switch {
		case rerr == unix.EINTR:
			continue
		case rerr == unix.ENOBUFS:
			// The socket's queue overflowed (a burst, `udevadm trigger`): the kernel dropped what didn't fit.
			r.Log("udev events were lost (the receive queue was full)")
			continue
		case rerr != nil:
			return fmt.Errorf("receive: %w", rerr)
		}
		msg := buf[:n]
		e, err := r.check(msg, flags, oob[:oobn], sa)
		if errors.Is(err, errOther) {
			continue
		}
		if err != nil {
			r.Log("dropped a message: " + err.Error())
			continue
		}
		var serr error
		if err := to.Write(func(fd uintptr) bool {
			serr = unix.Sendmsg(int(fd), msg, nil, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: udevMask}, 0)
			return serr != unix.EAGAIN
		}); err != nil {
			return err
		}
		switch {
		case serr == nil, serr == unix.ECONNREFUSED:
			// ECONNREFUSED: nobody listens, as udevd expects it too.
			if strings.HasPrefix(e.DevName, "/dev/input/event") {
				r.Log(fmt.Sprintf("passed %s %s", e.Action, strings.TrimPrefix(e.DevName, "/dev/input/")))
			}
		case serr == unix.EPERM:
			return fmt.Errorf("send: %w (CAP_NET_ADMIN is needed)", serr)
		default:
			r.Log(fmt.Sprintf("couldn't pass %s %s: %v", e.Action, e.Subsystem, serr))
		}
	}
}

// check decides one received message: from udevd's group, sent by uid 0 (as libudev requires), whole, udevd's
// format, and of a subsystem the relay passes (errOther otherwise).
func (r *Relay) check(msg []byte, flags int, oob []byte, sa unix.Sockaddr) (Event, error) {
	var e Event
	if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || len(msg) > MaxMessage {
		return e, errors.New("truncated")
	}
	if nl, ok := sa.(*unix.SockaddrNetlink); !ok || nl.Groups != udevMask {
		return e, errors.New("not sent to udevd's group")
	}
	uid, err := senderUID(oob)
	if err != nil {
		return e, err
	}
	if uid != 0 {
		return e, fmt.Errorf("sent by uid %d, not root", uid)
	}
	if e, err = Parse(msg); err != nil {
		return e, err
	}
	if !slices.Contains(r.Subsystems, e.Subsystem) {
		return e, errOther
	}
	return e, nil
}

// senderUID is the uid in the message's SCM_CREDENTIALS.
func senderUID(oob []byte) (uint32, error) {
	cmsgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return 0, fmt.Errorf("the sender's credentials: %w", err)
	}
	for i := range cmsgs {
		if c, err := unix.ParseUnixCredentials(&cmsgs[i]); err == nil {
			return c.Uid, nil
		}
	}
	return 0, errors.New("no sender credentials")
}

// control runs fn on the file's descriptor (Fd would make it blocking and take it out of Go's poller).
func control(f *os.File, fn func(fd int) error) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = fn(int(fd)) }); err != nil {
		return err
	}
	return ferr
}
