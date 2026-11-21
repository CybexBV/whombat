package consoleapi

// The box's Bluetooth on its screen (Whombat bluetooth.md BT-02…BT-11, brief §2.4; CG-200…): /api/state's `bluetooth`
// summary for the chip, and the Bluetooth sheet's requests, passed to the runtime's desk socket the way the Wi-Fi
// sheet's are: the page sends the fields named here, the server builds the runtime's request from them after checking
// each (an address as the contract writes it, a pairing's id), and answers with the runtime's checked, cleaned answer
// or its refusal's code (`locked` when the screen may not change Bluetooth now, `busy`, `no_bluetooth`, …).

import (
	"context"
	"net/http"

	"github.com/CybexBV/whombat/contracts/go/protocol"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// BluetoothSummary is /api/state's `bluetooth` (CG-201): why the adapter can't be used (absent: it can), and the
// devices connected now, for the chip. Null without a desk socket, without an answer, or without an adapter at all
// (`no_adapter`: no chip, BT-02's “where there is an adapter”).
type BluetoothSummary struct {
	Missing   string                `json:"missing,omitempty"` // no_driver | disabled
	Connected []BluetoothChipDevice `json:"connected"`
}

// BluetoothChipDevice is a connected device as the chip names it.
type BluetoothChipDevice struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// BluetoothSummaryOf is the chip's view of a Bluetooth answer.
func BluetoothSummaryOf(a *desk.BluetoothAnswer) *BluetoothSummary {
	if a == nil {
		return nil
	}
	// `missing` is there exactly when the adapter can't be used (BluetoothStateValid).
	b := a.Bluetooth
	s := &BluetoothSummary{Connected: []BluetoothChipDevice{}}
	if b.Missing != nil {
		if *b.Missing == protocol.BluetoothMissingNoAdapter {
			return nil
		}
		s.Missing = string(*b.Missing)
		return s
	}
	for _, d := range b.Devices {
		if d.Connected {
			s.Connected = append(s.Connected, BluetoothChipDevice{Name: d.Name, Kind: string(d.Kind)})
		}
	}
	return s
}

// bluetoothSummary is the summary from the desk client's cached answer (nil: no desk socket, or no answer).
func (s *Server) bluetoothSummary(ctx context.Context) *BluetoothSummary {
	if s.desk == nil {
		return nil
	}
	a, err := s.desk.Bluetooth(ctx, desk.BluetoothCacheFor)
	if err != nil {
		return nil
	}
	return BluetoothSummaryOf(a)
}

// bluetoothRoutes adds GET /api/bluetooth and POST /api/bluetooth/scan|pair|confirm|cancel|connect|disconnect|forget
// (404 without a desk socket, as the desk's requests).
func (s *Server) bluetoothRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/bluetooth", func(w http.ResponseWriter, r *http.Request) {
		if s.desk == nil {
			web.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !web.Method(w, r, http.MethodGet) {
			return
		}
		a, err := s.desk.Bluetooth(r.Context(), desk.BluetoothPollFor)
		if err != nil {
			deskError(w, err)
			return
		}
		web.JSON(w, http.StatusOK, a)
	})
	mux.HandleFunc("/api/bluetooth/scan", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.BluetoothScan(ctx)
		return a, true, err
	}))
	// The requests naming a device: {address}.
	for path, call := range map[string]func(context.Context, string) (any, error){
		"/api/bluetooth/pair":       func(ctx context.Context, a string) (any, error) { return s.desk.BluetoothPair(ctx, a) },
		"/api/bluetooth/connect":    func(ctx context.Context, a string) (any, error) { return s.desk.BluetoothConnect(ctx, a) },
		"/api/bluetooth/disconnect": func(ctx context.Context, a string) (any, error) { return s.desk.BluetoothDisconnect(ctx, a) },
		"/api/bluetooth/forget":     func(ctx context.Context, a string) (any, error) { return s.desk.BluetoothForget(ctx, a) },
	} {
		mux.HandleFunc(path, s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
			var in struct {
				Address string `json:"address"`
			}
			if !web.DecodeJSON(w, r, &in) {
				return nil, false, nil
			}
			a, err := call(ctx, in.Address)
			return a, true, err
		}))
	}
	mux.HandleFunc("/api/bluetooth/confirm", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			PairingID string `json:"pairingId"`
			Accept    *bool  `json:"accept"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		if in.Accept == nil {
			// Yes or No, said: a missing answer is never a No.
			web.Error(w, http.StatusBadRequest, desk.ErrorBadRequest)
			return nil, false, nil
		}
		a, err := s.desk.BluetoothConfirm(ctx, in.PairingID, *in.Accept)
		return a, true, err
	}))
	mux.HandleFunc("/api/bluetooth/cancel", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			PairingID string `json:"pairingId"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.BluetoothCancel(ctx, in.PairingID)
		return a, true, err
	}))
}
