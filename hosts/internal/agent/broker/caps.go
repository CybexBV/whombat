package broker

import "rackoon/internal/proto"

// GuestDisplay describes the console devices a guest has, as found by the
// collectors in the guest's configuration. LibvirtDisplay and PVEDisplay
// build it from a domain XML / PVE config.
type GuestDisplay struct {
	Kind     string   // "vm" | "container"
	Graphics []string // configured graphics: "vnc", "spice" (VMs); PVE: nil = default VNC
	Serial   bool     // a serial console the agent can attach to
	Running  bool
	// Unavailable lists protocols the guest has but the broker cannot serve,
	// with the reason shown in the UI (e.g. SPICE with TLS only).
	Unavailable map[string]string
}

// Caps returns the console capabilities the broker can serve for a guest.
// Collectors call it so that what the UI offers matches what the broker can
// actually open. Rules (REMOTE-CONSOLE.md 1, PRODUCT-SPEC.md C3):
//
//	docker:            shell, logs (default shell)
//	incus container:   shell, tty (default shell)
//	incus VM:          spice (VGA), serial (default spice)
//	libvirt VM:        configured vnc / spice, serial when present (default first graphical)
//	pve qemu:          vnc, spice when configured (vga: qxl), serial when present (default vnc)
//	pve lxc:           shell, tty (default shell)
//
// Protocols listed in d.Unavailable are reported in ConsoleCaps.Unavailable
// and left out of Protocols.
func Caps(platform string, d GuestDisplay) proto.ConsoleCaps {
	var c proto.ConsoleCaps
	var protos []string
	switch platform {
	case proto.PlatformDocker:
		// Listed whether or not the container runs: the hub offers logs of
		// stopped containers and refuses their shell.
		protos = []string{proto.ProtoShell, proto.ProtoLogs}
	case proto.PlatformIncus:
		if d.Kind == "container" {
			protos = []string{proto.ProtoShell, proto.ProtoTTY}
		} else {
			protos = []string{proto.ProtoSPICE, proto.ProtoSerial}
		}
	case proto.PlatformLibvirt:
		for _, g := range d.Graphics {
			if g == proto.ProtoVNC || g == proto.ProtoSPICE {
				protos = append(protos, g)
			}
		}
		if d.Serial {
			protos = append(protos, proto.ProtoSerial)
		}
	case proto.PlatformPVE:
		if d.Kind == "container" {
			protos = []string{proto.ProtoShell, proto.ProtoTTY}
		} else {
			graphics := d.Graphics
			if graphics == nil {
				graphics = []string{proto.ProtoVNC}
			}
			for _, g := range []string{proto.ProtoVNC, proto.ProtoSPICE} {
				for _, have := range graphics {
					if have == g {
						protos = append(protos, g)
					}
				}
			}
			if d.Serial {
				protos = append(protos, proto.ProtoSerial)
			}
		}
	}
	for _, p := range protos {
		if reason, ok := d.Unavailable[p]; ok {
			if c.Unavailable == nil {
				c.Unavailable = map[string]string{}
			}
			c.Unavailable[p] = reason
			continue
		}
		c.Protocols = append(c.Protocols, p)
	}
	// Reasons for protocols the platform has that are not in the list above
	// (e.g. PVE VNC on a VM whose display is the serial console).
	for p, reason := range d.Unavailable {
		if _, ok := c.Unavailable[p]; ok {
			continue
		}
		if c.Unavailable == nil {
			c.Unavailable = map[string]string{}
		}
		c.Unavailable[p] = reason
	}
	if len(c.Protocols) > 0 {
		c.Default = c.Protocols[0]
	}
	return c
}
