package relay

import (
	"encoding/binary"
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// message builds what udevd sends for a device (systemd's device_monitor_send): the header, then the properties.
func message(props ...string) []byte {
	p := []byte(strings.Join(props, "\x00") + "\x00")
	m := make([]byte, headerSize, headerSize+len(p))
	copy(m, "libudev\x00")
	binary.BigEndian.PutUint32(m[8:], magic)
	binary.NativeEndian.PutUint32(m[12:], headerSize)
	binary.NativeEndian.PutUint32(m[16:], headerSize)
	binary.NativeEndian.PutUint32(m[20:], uint32(len(p)))
	return append(m, p...)
}

var keyboard = []string{
	"ACTION=add", "DEVPATH=/devices/pci0000:00/0000:00:01.2/usb1/1-1/1-1:1.0/0003:0627:0001.0001/input/input7/event7",
	"SUBSYSTEM=input", "DEVNAME=/dev/input/event7", "SEQNUM=2412", "USEC_INITIALIZED=81234567", "ID_INPUT=1",
	"ID_INPUT_KEYBOARD=1", "UNIQ=aa:bb:cc:dd:ee:ff", "MAJOR=13", "MINOR=71", "TAGS=:seat:uaccess:",
}

func TestParse(t *testing.T) {
	e, err := Parse(message(keyboard...))
	if err != nil {
		t.Fatal(err)
	}
	if e != (Event{Action: "add", Subsystem: "input", DevName: "/dev/input/event7"}) {
		t.Fatalf("%+v", e)
	}

	good := message(keyboard...)
	for name, msg := range map[string][]byte{
		"empty":          nil,
		"short":          good[:headerSize-1],
		"kernel's":       []byte("add@/devices/virtual/input/input7\x00ACTION=add\x00SUBSYSTEM=input\x00SEQNUM=1\x00padding to the header's length"),
		"magic":          func() []byte { m := clone(good); m[8] ^= 1; return m }(),
		"offset":         func() []byte { m := clone(good); binary.NativeEndian.PutUint32(m[16:], 8); return m }(),
		"length":         func() []byte { m := clone(good); binary.NativeEndian.PutUint32(m[20:], uint32(len(m))); return m }(),
		"no length":      func() []byte { m := clone(good); binary.NativeEndian.PutUint32(m[20:], 0); return m }(),
		"no subsystem":   message("ACTION=add", "DEVNAME=/dev/input/event7"),
		"no action":      message("SUBSYSTEM=input"),
		"cut properties": good[:len(good)-4],
	} {
		if _, err := Parse(msg); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

func clone(b []byte) []byte { return append([]byte(nil), b...) }

// creds is the control message the kernel adds with SO_PASSCRED.
func creds(uid uint32) []byte {
	return unix.UnixCredentials(&unix.Ucred{Pid: 412, Uid: uid, Gid: uid})
}

func TestCheck(t *testing.T) {
	r := &Relay{Subsystems: []string{"input"}}
	group := &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: udevMask}
	if e, err := r.check(message(keyboard...), 0, creds(0), group); err != nil || e.DevName != "/dev/input/event7" {
		t.Fatalf("%+v %v", e, err)
	}
	// A device of another subsystem: skipped, not logged.
	disk := message("ACTION=add", "SUBSYSTEM=block", "DEVNAME=/dev/sda")
	if _, err := r.check(disk, 0, creds(0), group); !errors.Is(err, errOther) {
		t.Fatalf("block: %v", err)
	}
	for name, c := range map[string]struct {
		msg   []byte
		flags int
		oob   []byte
		sa    unix.Sockaddr
	}{
		"another uid":    {message(keyboard...), 0, creds(1000), group},
		"no credentials": {message(keyboard...), 0, nil, group},
		"truncated":      {message(keyboard...), unix.MSG_TRUNC, creds(0), group},
		"too long":       {append(message(keyboard...), make([]byte, MaxMessage)...), 0, creds(0), group},
		"kernel's group": {message(keyboard...), 0, creds(0), &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: 1}},
		"unicast":        {message(keyboard...), 0, creds(0), &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Pid: 412}},
		"no address":     {message(keyboard...), 0, creds(0), nil},
		"not udevd's":    {[]byte("add@/devices/virtual/input/input7\x00ACTION=add\x00SUBSYSTEM=input\x00SEQNUM=1\x00"), 0, creds(0), group},
	} {
		if _, err := r.check(c.msg, c.flags, c.oob, c.sa); err == nil || errors.Is(err, errOther) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
