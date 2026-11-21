// Command bt-peer plays a Bluetooth mouse on a virtual controller for the `bluetooth` VM test (NX-362): it takes the
// controller through the HCI user channel (so bluetoothd doesn't see it as one of the box's adapters), names itself,
// says it is a mouse (Class of Device 0x000580), stays connectable and discoverable, and pairs Just Works
// (NoInputNoOutput) with whoever asks, refusing every L2CAP channel (it has no services). Test only; never in an image.
//
//	bt-peer --index 1 --name "Whombat Test Mouse"
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	afBluetooth    = 31
	btprotoHCI     = 1
	hciChannelUser = 1

	pktCommand = 0x01
	pktACL     = 0x02
	pktEvent   = 0x04
)

type sockaddrHCI struct {
	family  uint16
	dev     uint16
	channel uint16
}

type peer struct {
	fd   int
	keys map[[6]byte][16]byte
}

func main() {
	index := flag.Int("index", 1, "the controller (hciN)")
	name := flag.String("name", "Whombat Test Mouse", "the name it gives itself")
	flag.Parse()
	fd, err := syscall.Socket(afBluetooth, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, btprotoHCI)
	if err != nil {
		fatal("socket: %v", err)
	}
	sa := sockaddrHCI{family: afBluetooth, dev: uint16(*index), channel: hciChannelUser}
	if _, _, e := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa)); e != 0 {
		fatal("bind hci%d (user channel): %v", *index, e)
	}
	p := &peer{fd: fd, keys: map[[6]byte][16]byte{}}

	p.cmd(0x03, 0x0003, nil)                                                    // Reset
	p.cmd(0x03, 0x0001, []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f}) // Set Event Mask: all
	p.cmd(0x03, 0x0056, []byte{0x01})                                           // Write Simple Pairing Mode: on
	p.cmd(0x03, 0x0045, []byte{0x02})                                           // Write Inquiry Mode: with EIR
	local := make([]byte, 248)
	copy(local, *name)
	p.cmd(0x03, 0x0013, local) // Write Local Name
	eir := make([]byte, 241)
	eir[0] = 0 // FEC not required
	eir[1] = byte(len(*name) + 1)
	eir[2] = 0x09 // Complete Local Name
	copy(eir[3:], *name)
	p.cmd(0x03, 0x0052, eir)                      // Write Extended Inquiry Response
	p.cmd(0x03, 0x0024, []byte{0x80, 0x05, 0x00}) // Write Class of Device: peripheral, pointing
	p.cmd(0x03, 0x001a, []byte{0x03})             // Write Scan Enable: inquiry and page
	fmt.Println("bt-peer: ready as", *name)
	p.loop()
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "bt-peer: "+f+"\n", a...)
	os.Exit(1)
}

func (p *peer) write(b []byte) {
	if _, err := syscall.Write(p.fd, b); err != nil {
		fatal("write: %v", err)
	}
}

// cmd sends a command and waits for its Command Complete or Command Status (events meanwhile are handled).
func (p *peer) cmd(ogf, ocf uint16, params []byte) {
	op := ogf<<10 | ocf
	b := []byte{pktCommand, byte(op), byte(op >> 8), byte(len(params))}
	p.write(append(b, params...))
	for {
		pkt := p.read()
		if pkt[0] != pktEvent {
			continue
		}
		ev, data := pkt[1], pkt[3:]
		switch {
		case ev == 0x0e && len(data) >= 4 && binary.LittleEndian.Uint16(data[1:]) == op: // Command Complete
			if data[3] != 0 {
				fatal("command %04x: status %02x", op, data[3])
			}
			return
		case ev == 0x0f && len(data) >= 4 && binary.LittleEndian.Uint16(data[2:]) == op: // Command Status
			if data[0] != 0 {
				fatal("command %04x: status %02x", op, data[0])
			}
			return
		}
		p.event(ev, data)
	}
}

// reply sends a command without waiting (answers to the remote side's requests, from the loop).
func (p *peer) reply(ogf, ocf uint16, params []byte) {
	op := ogf<<10 | ocf
	b := []byte{pktCommand, byte(op), byte(op >> 8), byte(len(params))}
	p.write(append(b, params...))
}

func (p *peer) read() []byte {
	buf := make([]byte, 1100)
	n, err := syscall.Read(p.fd, buf)
	if err != nil {
		fatal("read: %v", err)
	}
	return buf[:n]
}

func (p *peer) loop() {
	for {
		pkt := p.read()
		switch pkt[0] {
		case pktEvent:
			p.event(pkt[1], pkt[3:])
		case pktACL:
			p.acl(pkt[1:])
		}
	}
}

func addr(b []byte) (a [6]byte) { copy(a[:], b[:6]); return a }

func (p *peer) event(ev byte, data []byte) {
	switch ev {
	case 0x04: // Connection Request → accept, stay peripheral
		fmt.Println("bt-peer: connection request")
		p.reply(0x01, 0x0009, append(append([]byte{}, data[:6]...), 0x01))
	case 0x03: // Connection Complete
		fmt.Printf("bt-peer: connected (status %02x)\n", data[0])
	case 0x05: // Disconnection Complete
		fmt.Println("bt-peer: disconnected")
	case 0x31: // IO Capability Request → NoInputNoOutput, no OOB, general bonding without MITM
		p.reply(0x01, 0x002b, append(append([]byte{}, data[:6]...), 0x03, 0x00, 0x04))
	case 0x33: // User Confirmation Request → yes (Just Works)
		p.reply(0x01, 0x002c, data[:6])
	case 0x17: // Link Key Request
		a := addr(data)
		if k, ok := p.keys[a]; ok {
			p.reply(0x01, 0x000b, append(append([]byte{}, data[:6]...), k[:]...))
		} else {
			p.reply(0x01, 0x000c, data[:6])
		}
	case 0x18: // Link Key Notification
		var k [16]byte
		copy(k[:], data[6:22])
		p.keys[addr(data)] = k
		fmt.Println("bt-peer: paired")
	case 0x16: // PIN Code Request: no PIN here
		p.reply(0x01, 0x000e, data[:6])
	case 0x36: // Simple Pairing Complete
		fmt.Printf("bt-peer: simple pairing complete (status %02x)\n", data[0])
	}
}

// acl answers L2CAP signalling: no channel is accepted, no extended feature is supported.
func (p *peer) acl(b []byte) {
	if len(b) < 8 {
		return
	}
	handle := binary.LittleEndian.Uint16(b) & 0x0fff
	l2 := b[4:]
	if binary.LittleEndian.Uint16(l2[2:]) != 0x0001 || len(l2) < 8 { // the signalling channel only
		return
	}
	code, ident := l2[4], l2[5]
	params := l2[8:]
	var out []byte
	switch code {
	case 0x02: // Connection Request → refused, PSM not supported
		if len(params) < 4 {
			return
		}
		out = []byte{0x03, ident, 8, 0, 0, 0, params[2], params[3], 0x02, 0x00, 0x00, 0x00}
	case 0x0a: // Information Request → not supported
		if len(params) < 2 {
			return
		}
		out = []byte{0x0b, ident, 4, 0, params[0], params[1], 0x01, 0x00}
	case 0x08: // Echo Request
		out = []byte{0x09, ident, 0, 0}
	case 0x03, 0x0b, 0x09, 0x01:
		return
	default: // Command Reject: not understood
		out = []byte{0x01, ident, 2, 0, 0x00, 0x00}
	}
	l2out := make([]byte, 4, 4+len(out))
	binary.LittleEndian.PutUint16(l2out, uint16(len(out)))
	binary.LittleEndian.PutUint16(l2out[2:], 0x0001)
	l2out = append(l2out, out...)
	acl := make([]byte, 5, 5+len(l2out))
	acl[0] = pktACL
	binary.LittleEndian.PutUint16(acl[1:], handle|0x2000) // first automatically flushable packet
	binary.LittleEndian.PutUint16(acl[3:], uint16(len(l2out)))
	p.write(append(acl, l2out...))
}
