package api

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/appliance/bluetooth/internal/service"
	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

const (
	hci0     = "/org/bluez/hci0"
	keychron = "AA:00:00:00:00:01"
	mx       = "AA:00:00:00:00:03"
)

func i16(v int16) *int16 { return &v }

// newServer is the socket over the real service and a fake BlueZ: a powered adapter, a paired keyboard, a mouse found.
func newServer(t *testing.T) (*Server, *bluez.Fake) {
	sys := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sys, "class", "bluetooth", "hci0"), 0o755); err != nil {
		t.Fatal(err)
	}
	bz := bluez.NewFake(
		[]bluez.Adapter{{Path: hci0, Alias: "whombat", Powered: true}},
		[]bluez.Device{
			{Path: hci0 + "/dev_1", Adapter: hci0, Address: keychron, Name: "Keychron K3", Icon: "input-keyboard", Paired: true, Connected: true},
			{Path: hci0 + "/dev_3", Adapter: hci0, Address: mx, Name: "MX Master 3S", Icon: "input-mouse", RSSI: i16(-50)},
		},
	)
	cfg := service.Defaults()
	cfg.Sys = sys
	return &Server{Bluetooth: service.New(cfg, bz, service.RealClock, t.Logf)}, bz
}

func call(s *Server, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

// decode reads an answer with the contract's parser (strict, every member known and valid).
func decode[T any](t *testing.T, rec *httptest.ResponseRecorder, status int, parser func([]byte) (*T, error)) *T {
	t.Helper()
	v, err := parser(rec.Body.Bytes())
	if rec.Code != status || err != nil || rec.Body.Len() > local.BluetoothAnswerMaxBytes {
		t.Fatalf("got %d %s (%v), want %d", rec.Code, rec.Body.String(), err, status)
	}
	return v
}

// errorCode checks a LocalError's status and code.
func errorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	e, err := local.ParseLocalError(rec.Body.Bytes())
	if rec.Code != status || err != nil || e.Error.Code != code {
		t.Fatalf("got %d %s (%v), want %d %s", rec.Code, rec.Body.String(), err, status, code)
	}
}

func TestState(t *testing.T) {
	s, _ := newServer(t)
	a := decode(t, call(s, http.MethodGet, local.BluetoothPathState, ""), 200, local.ParseBluetoothStateAnswer)
	st := a.Bluetooth
	if a.V != 1 || st.Adapter == nil || st.Adapter.Name != "whombat" || len(st.Devices) != 1 || st.Devices[0].Name != "Keychron K3" ||
		st.Scan != nil || st.Pairing != nil {
		t.Fatalf("%+v", a)
	}
	// null, not missing: the scan and the pairing; no missing while the adapter is on.
	body := call(s, http.MethodGet, local.BluetoothPathState, "").Body.String()
	if !strings.Contains(body, `"scan":null`) || !strings.Contains(body, `"pairing":null`) || strings.Contains(body, "missing") {
		t.Fatal(body)
	}
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathState, `{"v":1}`), 405, "bad_request")
	errorCode(t, call(s, http.MethodGet, "/v1/bluetooth/nothing", ""), 404, "bad_request")
}

func TestScanPairConfirmCancel(t *testing.T) {
	s, bz := newServer(t)
	sc := decode(t, call(s, http.MethodPost, local.BluetoothPathScan, `{"v":1}`), 200, local.ParseBluetoothScanAnswer)
	if len(sc.Scan.Devices) != 1 || sc.Scan.Devices[0].Address != mx || *sc.Scan.Devices[0].Signal != 4 {
		t.Fatalf("%+v", sc)
	}
	confirmed := make(chan error, 1)
	bz.Script(hci0+"/dev_3", func(ctx context.Context, a bluez.Agent) error {
		confirmed <- a.RequestConfirmation(hci0+"/dev_3", 987654)
		<-ctx.Done()
		return ctx.Err()
	})
	p := decode(t, call(s, http.MethodPost, local.BluetoothPathPair, `{"v":1,"address":"`+mx+`"}`), 202, local.ParseBluetoothPairingAnswer)
	if p.Pairing.Phase != protocol.BluetoothPairingPhasePairing || !strings.HasPrefix(p.Pairing.ID, "p-") {
		t.Fatalf("%+v", p)
	}
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathPair, `{"v":1,"address":"`+keychron+`"}`), 409, "busy")
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathScan, `{"v":1}`), 409, "busy")
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathConfirm, `{"v":1,"pairingId":"p-notthisone","accept":true}`), 404, "not_found")
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathConfirm, `{"v":1,"pairingId":"`+p.Pairing.ID+`"}`), 400, "bad_request")
	c := decode(t, call(s, http.MethodPost, local.BluetoothPathCancel, `{"v":1,"pairingId":"`+p.Pairing.ID+`"}`), 200, local.ParseBluetoothPairingAnswer)
	if c.Pairing.Phase != protocol.BluetoothPairingPhaseFailed || *c.Pairing.Failure != protocol.BluetoothPairingFailureCanceled {
		t.Fatalf("%+v", c)
	}
	<-confirmed
}

func TestDevices(t *testing.T) {
	s, _ := newServer(t)
	d := decode(t, call(s, http.MethodPost, local.BluetoothPathDisconnect, `{"v":1,"address":"`+keychron+`"}`), 200, local.ParseBluetoothDeviceAnswer)
	if d.Device.Connected {
		t.Fatalf("%+v", d)
	}
	d = decode(t, call(s, http.MethodPost, local.BluetoothPathConnect, `{"v":1,"address":"`+keychron+`"}`), 200, local.ParseBluetoothDeviceAnswer)
	if !d.Device.Connected {
		t.Fatalf("%+v", d)
	}
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathConnect, `{"v":1,"address":"`+mx+`"}`), 409, "not_paired")
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathForget, `{"v":1,"address":"CC:00:00:00:00:00"}`), 404, "not_found")
	ack := decode(t, call(s, http.MethodPost, local.BluetoothPathForget, `{"v":1,"address":"`+keychron+`"}`), 200, local.ParseBluetoothAck)
	if ack.V != 1 {
		t.Fatal(ack)
	}
}

func TestStrict(t *testing.T) {
	s, bz := newServer(t)
	for _, body := range []string{``, `{}`, `{"v":2}`, `{"v":1.5}`, `{"v":"1"}`, `{"v":1,"x":1}`, `{"v":1}{"v":1}`, `[1]`, `null`} {
		errorCode(t, call(s, http.MethodPost, local.BluetoothPathScan, body), 400, "bad_request")
	}
	for _, a := range []string{`"aa:00:00:00:00:03"`, `"AA:00:00:00:00"`, `null`, `3`} {
		errorCode(t, call(s, http.MethodPost, local.BluetoothPathPair, `{"v":1,"address":`+a+`}`), 400, "bad_request")
	}
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathCancel, `{"v":1,"pairingId":"P-ABCDEFGH"}`), 400, "bad_request")
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathScan, `{"v":1,"pad":"`+strings.Repeat("x", 1100)+`"}`), 413, "too_large")
	bz.Down = true
	errorCode(t, call(s, http.MethodGet, local.BluetoothPathState, ""), 503, "unavailable")
	bz.Down = false
	bz.Update(hci0, nil, func(a *bluez.Adapter) { a.Powered = false })
	errorCode(t, call(s, http.MethodPost, local.BluetoothPathScan, `{"v":1}`), 409, "no_bluetooth")
}

func TestPeerCheck(t *testing.T) {
	dir, err := os.MkdirTemp("", "bluetooth-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	get := func(allow uint32) int {
		sock := filepath.Join(dir, "b.sock")
		_ = os.Remove(sock)
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		s, _ := newServer(t)
		s.AllowUIDs = []uint32{allow}
		srv := &http.Server{Handler: s.Handler(), ConnContext: peercred.ConnContext}
		go func() { _ = srv.Serve(l) }()
		defer srv.Close()
		c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
		r, err := c.Get("http://bluetooth" + local.BluetoothPathState)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	if got := get(uint32(os.Getuid())); got != 200 {
		t.Fatalf("own uid: %d", got)
	}
	if got := get(uint32(os.Getuid()) + 1); got != 403 {
		t.Fatalf("other uid: %d", got)
	}
}
