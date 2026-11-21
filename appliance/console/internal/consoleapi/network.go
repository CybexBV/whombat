package consoleapi

// The box's network on its screen (Whombat hardware-support.md HD-07…HD-09, brief §2.6; CG-100…): /api/state's
// `network` summary for the chip, and the Wi-Fi sheet's four requests, passed to the runtime's desk socket (§2.5) the
// way the desk's are: the page sends the fields named here, the server builds the runtime's request from them after
// checking each (desk.WifiJoin), and answers with the runtime's checked, cleaned answer or its refusal's code. A
// passphrase goes to the runtime and nowhere else (not in an error, not in the log).

import (
	"context"
	"net/http"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// NetworkSummary is /api/state's `network` (§2.6): whether the box reached Whombat, what it uses (a cable wins, HD-05),
// the Wi-Fi network's name while that is what it uses, and why the box has no Wi-Fi it can use (the waiting scene
// offers Wi-Fi only with a card that works, CG-106).
type NetworkSummary struct {
	Online      bool   `json:"online"`
	Via         string `json:"via"` // cable | wifi | none
	Ssid        string `json:"ssid,omitempty"`
	WifiMissing string `json:"wifiMissing,omitempty"` // no_adapter | no_driver | disabled
}

// Summary is the chip's view of a network answer.
func Summary(a *desk.NetworkAnswer) *NetworkSummary {
	if a == nil {
		return nil
	}
	n := a.Network
	s := &NetworkSummary{Online: n.Online, Via: "none"}
	if n.WifiMissing != nil {
		s.WifiMissing = string(*n.WifiMissing)
	}
	for _, w := range n.Wired {
		if w.Connected {
			s.Via = "cable"
			return s
		}
	}
	if w := n.Wifi; w != nil && w.State == "connected" {
		s.Via = "wifi"
		if w.Ssid != nil {
			s.Ssid = *w.Ssid
		}
	}
	return s
}

// networkSummary is the summary from the desk client's cached answer (nil: no desk socket, or no answer).
func (s *Server) networkSummary(ctx context.Context) *NetworkSummary {
	if s.desk == nil {
		return nil
	}
	a, err := s.desk.Network(ctx)
	if err != nil {
		return nil
	}
	return Summary(a)
}

// networkRoutes adds GET /api/network and POST /api/network/wifi/scan|join|forget (404 without a desk socket, as the
// desk's requests).
func (s *Server) networkRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/network", func(w http.ResponseWriter, r *http.Request) {
		if s.desk == nil {
			web.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !web.Method(w, r, http.MethodGet) {
			return
		}
		a, err := s.desk.Network(r.Context())
		if err != nil {
			deskError(w, err)
			return
		}
		web.JSON(w, http.StatusOK, a)
	})
	mux.HandleFunc("/api/network/wifi/scan", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.WifiScan(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/network/wifi/join", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Ssid       string  `json:"ssid"`
			Passphrase *string `json:"passphrase"`
			Hidden     bool    `json:"hidden"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.WifiJoin(ctx, in.Ssid, in.Passphrase, in.Hidden)
		return a, true, err
	}))
	mux.HandleFunc("/api/network/wifi/forget", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Ssid string `json:"ssid"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.WifiForget(ctx, in.Ssid)
		return a, true, err
	}))
}
