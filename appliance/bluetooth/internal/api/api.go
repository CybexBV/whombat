// Package api is the Bluetooth socket (contracts 0.109.0 `local`, the build brief's §2.3; Whombat BT-01…BT-10;
// NX-354): HTTP/1.1 JSON on /run/whombat-bluetooth/bluetooth.sock, used by the runtime server only.
//
//	GET  /v1/bluetooth/state             → { v:1, bluetooth: BluetoothState }
//	POST /v1/bluetooth/scan              { v:1 } → { v:1, scan }            (looks, or 60 s more)
//	POST /v1/bluetooth/pair              { v:1, address } → 202 { v:1, pairing }
//	POST /v1/bluetooth/pairing/confirm   { v:1, pairingId, accept } → { v:1, pairing }
//	POST /v1/bluetooth/pairing/cancel    { v:1, pairingId } → { v:1, pairing }
//	POST /v1/bluetooth/connect           { v:1, address } → { v:1, device }  (waits ≤ 15 s)
//	POST /v1/bluetooth/disconnect        { v:1, address } → { v:1, device }
//	POST /v1/bluetooth/forget            { v:1, address } → { v:1 }
//
// Requests are strict (the contract's parsers: no other member, v = 1) and at most 1 KiB. Errors are LocalError with
// the contract's statuses (BluetoothSocketErrorStatus): 400 bad_request (not the request; a wrong path 404 and method
// 405, both bad_request), 413 too_large, 409 no_bluetooth, busy and not_paired, 404 not_found, 503 unavailable (BlueZ
// didn't answer). A peer that isn't the runtime or root gets 403 forbidden.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/service"
	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Bluetooth is the service (service.Service).
type Bluetooth interface {
	State() (protocol.BluetoothState, error)
	Scan() (protocol.BluetoothScan, error)
	Pair(address string) (protocol.BluetoothPairing, error)
	Confirm(id string, accept bool) (protocol.BluetoothPairing, error)
	Cancel(id string) (protocol.BluetoothPairing, error)
	Connect(address string) (protocol.BluetoothDevice, error)
	Disconnect(address string) (protocol.BluetoothDevice, error)
	Forget(address string) error
}

// Server serves the Bluetooth socket.
type Server struct {
	Bluetooth Bluetooth
	// AllowUIDs: the peers that may connect (SO_PEERCRED); empty lets in whoever the socket's mode lets in.
	AllowUIDs []uint32
}

// Handler routes the paths behind the peer check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(local.BluetoothPathState, method(http.MethodGet, s.state))
	mux.HandleFunc(local.BluetoothPathScan, method(http.MethodPost, s.scan))
	mux.HandleFunc(local.BluetoothPathPair, method(http.MethodPost, s.pair))
	mux.HandleFunc(local.BluetoothPathConfirm, method(http.MethodPost, s.confirm))
	mux.HandleFunc(local.BluetoothPathCancel, method(http.MethodPost, s.cancel))
	mux.HandleFunc(local.BluetoothPathConnect, method(http.MethodPost, s.connect))
	mux.HandleFunc(local.BluetoothPathDisconnect, method(http.MethodPost, s.disconnect))
	mux.HandleFunc(local.BluetoothPathForget, method(http.MethodPost, s.forget))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		failStatus(w, http.StatusNotFound, local.BluetoothErrorBadRequest, "no such path")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(s.AllowUIDs) > 0 {
			c, ok := peercred.FromContext(r.Context())
			if !ok || !slices.Contains(s.AllowUIDs, c.UID) {
				fail(w, "forbidden", "this socket is the runtime's")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func method(m string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != m {
			w.Header().Set("Allow", m)
			failStatus(w, http.StatusMethodNotAllowed, local.BluetoothErrorBadRequest, m+" only")
			return
		}
		h(w, r)
	}
}

func (s *Server) state(w http.ResponseWriter, _ *http.Request) {
	st, err := s.Bluetooth.State()
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothStateAnswer{V: 1, Bluetooth: st})
}

func (s *Server) scan(w http.ResponseWriter, r *http.Request) {
	if _, ok := parse(w, r, local.ParseBluetoothScanRequest); !ok {
		return
	}
	sc, err := s.Bluetooth.Scan()
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothScanAnswer{V: 1, Scan: sc})
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	req, ok := parse(w, r, local.ParseBluetoothDeviceRequest)
	if !ok {
		return
	}
	p, err := s.Bluetooth.Pair(req.Address)
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusAccepted, local.BluetoothPairingAnswer{V: 1, Pairing: p})
}

func (s *Server) confirm(w http.ResponseWriter, r *http.Request) {
	req, ok := parse(w, r, local.ParseBluetoothConfirmRequest)
	if !ok {
		return
	}
	p, err := s.Bluetooth.Confirm(req.PairingID, req.Accept)
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothPairingAnswer{V: 1, Pairing: p})
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	req, ok := parse(w, r, local.ParseBluetoothCancelRequest)
	if !ok {
		return
	}
	p, err := s.Bluetooth.Cancel(req.PairingID)
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothPairingAnswer{V: 1, Pairing: p})
}

func (s *Server) device(w http.ResponseWriter, r *http.Request, op func(string) (protocol.BluetoothDevice, error)) {
	req, ok := parse(w, r, local.ParseBluetoothDeviceRequest)
	if !ok {
		return
	}
	d, err := op(req.Address)
	if err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothDeviceAnswer{V: 1, Device: d})
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request) { s.device(w, r, s.Bluetooth.Connect) }

func (s *Server) disconnect(w http.ResponseWriter, r *http.Request) {
	s.device(w, r, s.Bluetooth.Disconnect)
}

func (s *Server) forget(w http.ResponseWriter, r *http.Request) {
	req, ok := parse(w, r, local.ParseBluetoothDeviceRequest)
	if !ok {
		return
	}
	if err := s.Bluetooth.Forget(req.Address); err != nil {
		failErr(w, err)
		return
	}
	reply(w, http.StatusOK, local.BluetoothAck{V: 1})
}

// parse reads a request of at most 1 KiB with the contract's parser (strict: no other member, v = 1, the address and
// the pairing id's patterns); false when it answered.
func parse[T any](w http.ResponseWriter, r *http.Request, parser func([]byte) (*T, error)) (*T, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, local.BluetoothRequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, local.BluetoothErrorTooLarge, "the body is larger than 1 KiB")
		} else {
			fail(w, local.BluetoothErrorBadRequest, "can't read the body")
		}
		return nil, false
	}
	req, err := parser(body)
	if err != nil {
		fail(w, local.BluetoothErrorBadRequest, "not the request this path takes")
		return nil, false
	}
	return req, true
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func failErr(w http.ResponseWriter, err error) {
	var e *service.Error
	if !errors.As(err, &e) {
		fail(w, local.BluetoothErrorUnavailable, "the Bluetooth service failed")
		return
	}
	fail(w, e.Code, e.Message)
}

// failStatus answers a LocalError with its own status (a wrong path 404, a wrong method 405: both bad_request).
func failStatus(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(local.LocalError{Error: local.LocalErrorError{Code: code, Message: message}})
}

// fail answers a LocalError with the code's status (the contract's BluetoothSocketErrorStatus; forbidden is 403).
func fail(w http.ResponseWriter, code, message string) {
	status, ok := local.BluetoothSocketErrorStatus[code]
	if !ok {
		status = http.StatusForbidden
		if code != "forbidden" {
			status = http.StatusServiceUnavailable
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(local.LocalError{Error: local.LocalErrorError{Code: code, Message: message}})
}
