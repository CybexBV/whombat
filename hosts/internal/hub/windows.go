package hub

import (
	"crypto/tls"

	"rackoon/internal/proto"
)

// sanitizeWindows bounds a Windows PC's block: its names, its antivirus
// list and its drives, and words the hub knows.
func sanitizeWindows(w *proto.Windows) {
	if w == nil {
		return
	}
	for _, p := range []*string{&w.Product, &w.DisplayVersion, &w.Build, &w.Edition, &w.Manufacturer, &w.Model} {
		clampStr(p, maxLabel)
	}
	if d := w.Defender; d != nil {
		switch d.Mode {
		case proto.DefenderNormal, proto.DefenderPassive, proto.DefenderEDRBlock, proto.DefenderOff:
		default:
			d.Mode = ""
		}
	}
	if len(w.Antivirus) > 8 {
		w.Antivirus = w.Antivirus[:8]
	}
	for i := range w.Antivirus {
		clampStr(&w.Antivirus[i].Name, maxLabel)
	}
	if len(w.BitLocker) > 26 {
		w.BitLocker = w.BitLocker[:26]
	}
	for i := range w.BitLocker {
		v := &w.BitLocker[i]
		clampStr(&v.Drive, 3)
		switch v.Protection {
		case proto.BitLockerOn, proto.BitLockerOff:
		default:
			v.Protection = proto.BitLockerUnknown
		}
	}
}

// agentTLS12Suites are the agent listener's TLS 1.2 suites: forward
// secret and authenticated, for the listener's ECDSA certificate (TLS 1.3
// has its own).
var agentTLS12Suites = []uint16{
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
}
