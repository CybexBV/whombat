package desk_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// The Bluetooth answer is the runtime's, checked; the chip takes one up to 2 s old, the sheet one up to 1 s old, and a
// change drops it.
func TestBluetoothCache(t *testing.T) {
	f := desktest.Start(t)
	c, ck := newClient(t, f)
	ctx := context.Background()
	a, err := c.Bluetooth(ctx, desk.BluetoothCacheFor)
	if err != nil || a.MayChange || *a.Why != "locked" || a.Bluetooth.Adapter == nil || len(a.Bluetooth.Devices) != 2 ||
		a.Bluetooth.Devices[0].Name != "Keychron K3" || *a.Bluetooth.Devices[0].Battery != 80 {
		t.Fatalf("%+v %v", a, err)
	}
	ck.add(1500 * time.Millisecond)
	_, _ = c.Bluetooth(ctx, desk.BluetoothCacheFor)
	if n := f.CallsTo(desk.PathBluetooth); n != 1 {
		t.Fatalf("the chip asked %d times within 2 s", n)
	}
	_, _ = c.Bluetooth(ctx, desk.BluetoothPollFor)
	if n := f.CallsTo(desk.PathBluetooth); n != 2 {
		t.Fatalf("the sheet took an answer 1.5 s old: %d", n)
	}
	if _, err := c.BluetoothScan(ctx); err != nil {
		t.Fatal(err)
	}
	_, _ = c.Bluetooth(ctx, desk.BluetoothCacheFor)
	if n := f.CallsTo(desk.PathBluetooth); n != 3 {
		t.Fatalf("not asked again after a scan: %d", n)
	}
	// A refusal is kept as long, and passed on as the runtime's.
	f.Set(desk.PathBluetooth, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	ck.add(3 * time.Second)
	_, err = c.Bluetooth(ctx, desk.BluetoothCacheFor)
	var de *desk.Error
	if !errors.As(err, &de) || de.Status != 404 {
		t.Fatal(err)
	}
	_, _ = c.Bluetooth(ctx, desk.BluetoothCacheFor)
	if n := f.CallsTo(desk.PathBluetooth); n != 4 {
		t.Fatalf("a refusal wasn't kept: %d", n)
	}
}

func btAnswer(state, may string) string { return `{"v":1,"bluetooth":` + state + `,` + may + `}` }

func btState(adapter, devices, scan, pairing string) string {
	return `{"adapter":` + adapter + `,"devices":` + devices + `,"scan":` + scan + `,"pairing":` + pairing + `}`
}

const (
	adapterOn = `{"name":"whombat","powered":true}`
	keyboard  = `{"address":"F4:7A:11:0B:32:C9","name":"Keychron K3","kind":"keyboard","connected":true}`
)

func pairing(phase, extra string) string {
	return `{"id":"p-0123abcd","address":"7C:C3:A1:5D:9B:14","name":"Magic Keyboard","kind":"keyboard","phase":"` +
		phase + `","deadline":"2026-10-20T09:42:30Z"` + extra + `}`
}

// What the runtime sends is the contract's or nothing (§2.1): the patterns, the bounds, the phases' members.
func TestParseBluetooth(t *testing.T) {
	may := `"mayChange":true`
	for name, tc := range map[string]struct {
		doc string
		ok  bool
	}{
		"minimal":             {btAnswer(btState(adapterOn, `[]`, `null`, `null`), may), true},
		"no adapter":          {btAnswer(`{"adapter":null,"missing":"no_adapter","devices":[],"scan":null,"pairing":null}`, may), true},
		"switched off":        {btAnswer(`{"adapter":{"name":"hci0","powered":false},"missing":"disabled","devices":[],"scan":null,"pairing":null}`, may), true},
		"off without missing": {btAnswer(`{"adapter":{"name":"hci0","powered":false},"devices":[],"scan":null,"pairing":null}`, may), false},
		"twice the same":      {btAnswer(btState(adapterOn, `[`+keyboard+`,`+keyboard+`]`, `null`, `null`), may), false},
		"paired and found":    {btAnswer(btState(adapterOn, `[`+keyboard+`]`, `{"until":"2026-10-20T09:42:00Z","devices":[`+keyboard+`]}`, `null`), may), false},
		"scan while pairing":  {btAnswer(btState(adapterOn, `[]`, `{"until":"2026-10-20T09:42:00Z","devices":[]}`, pairing("pairing", ``)), may), false},
		"scan after pairing":  {btAnswer(btState(adapterOn, `[]`, `{"until":"2026-10-20T09:42:00Z","devices":[]}`, pairing("done", ``)), may), true},
		"typed past the code": {btAnswer(btState(adapterOn, `[]`, `null`, pairing("code", `,"code":"1234","typed":5`)), may), false},
		"missing but on":      {btAnswer(`{"adapter":`+adapterOn+`,"missing":"disabled","devices":[],"scan":null,"pairing":null}`, may), false},
		"unknown missing":     {btAnswer(`{"adapter":null,"missing":"broken","devices":[],"scan":null,"pairing":null}`, may), false},
		"locked":              {btAnswer(btState(adapterOn, `[]`, `null`, `null`), locked), true},
		"why without lock":    {btAnswer(btState(adapterOn, `[]`, `null`, `null`), `"mayChange":true,"why":"locked"`), false},
		"lock without why":    {btAnswer(btState(adapterOn, `[]`, `null`, `null`), `"mayChange":false`), false},
		"version 2":           {strings.Replace(btAnswer(btState(adapterOn, `[]`, `null`, `null`), may), `"v":1`, `"v":2`, 1), false},
		"no devices member":   {btAnswer(`{"adapter":null,"missing":"no_adapter","scan":null,"pairing":null}`, may), false},
		"lower-case address":  {btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, "F4:7A", "f4:7a", 1)+`]`, `null`, `null`), may), false},
		"phone":               {btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, "keyboard", "phone", 1)+`]`, `null`, `null`), may), false},
		"battery 101":         {btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, `}`, `,"battery":101}`, 1)+`]`, `null`, `null`), may), false},
		"signal 5":            {btAnswer(btState(adapterOn, `[]`, `{"until":"2026-10-20T09:42:00Z","devices":[`+strings.Replace(keyboard, `}`, `,"signal":5}`, 1)+`]}`, `null`), may), false},
		"bad until":           {btAnswer(btState(adapterOn, `[]`, `{"until":"soon","devices":[]}`, `null`), may), false},
		"name with escape":    {btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, "Keychron K3", `Key\u001b[2Jchron`, 1)+`]`, `null`, `null`), may), false},
		"name 81":             {btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, "Keychron K3", strings.Repeat("é", 81), 1)+`]`, `null`, `null`), may), false},
		"pairing":             {btAnswer(btState(adapterOn, `[]`, `null`, pairing("pairing", ``)), may), true},
		"code":                {btAnswer(btState(adapterOn, `[]`, `null`, pairing("code", `,"code":"123456","typed":2`)), may), true},
		"code without code":   {btAnswer(btState(adapterOn, `[]`, `null`, pairing("code", ``)), may), false},
		"code of letters":     {btAnswer(btState(adapterOn, `[]`, `null`, pairing("confirm", `,"code":"12a456"`)), may), false},
		"typed in confirm":    {btAnswer(btState(adapterOn, `[]`, `null`, pairing("confirm", `,"code":"123456","typed":1`)), may), false},
		"code while pairing":  {btAnswer(btState(adapterOn, `[]`, `null`, pairing("pairing", `,"code":"123456"`)), may), false},
		"failed":              {btAnswer(btState(adapterOn, `[]`, `null`, pairing("failed", `,"failure":"rejected"`)), may), true},
		"failed without why":  {btAnswer(btState(adapterOn, `[]`, `null`, pairing("failed", ``)), may), false},
		"failure when done":   {btAnswer(btState(adapterOn, `[]`, `null`, pairing("done", `,"failure":"timeout"`)), may), false},
		"bad pairing id":      {btAnswer(btState(adapterOn, `[]`, `null`, strings.Replace(pairing("pairing", ``), "p-0123abcd", "x", 1)), may), false},
		"not json":            {`<html>`, false},
	} {
		_, err := desk.ParseBluetoothAnswer([]byte(tc.doc))
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", name, err)
		}
	}

	// What a pattern lets through is cleaned (ends trimmed); a name that comes out empty leaves the list, a pairing
	// whose name does is no pairing.
	doc := btAnswer(btState(`{"name":" hci0 ","powered":true}`,
		`[`+strings.Replace(keyboard, "Keychron K3", "  Keychron   K3  ", 1)+`,`+
			strings.Replace(strings.Replace(keyboard, "Keychron K3", "   ", 1), "F4:7A", "F4:7B", 1)+`]`,
		`null`, strings.Replace(pairing("pairing", ``), "Magic Keyboard", " ", 1)), may)
	a, err := desk.ParseBluetoothAnswer([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if b := a.Bluetooth; b.Adapter.Name != "hci0" || len(b.Devices) != 1 || b.Devices[0].Name != "Keychron K3" || b.Pairing != nil {
		t.Fatalf("%+v", b)
	}
}

// Each request is built here from checked fields; nothing that isn't an address or a pairing's id reaches the runtime;
// the runtime's refusals pass on with their codes.
func TestBluetoothRequests(t *testing.T) {
	f := desktest.Start(t)
	var l logs
	c := desk.New(f.Socket, os.Getuid(), nil, l.logf)
	ctx := context.Background()
	if a, err := c.BluetoothScan(ctx); err != nil || len(a.Scan.Devices) != 2 || a.Scan.Devices[0].Kind != "mouse" {
		t.Fatalf("%+v %v", a, err)
	}
	p, err := c.BluetoothPair(ctx, "7C:C3:A1:5D:9B:14")
	if err != nil || p.Pairing.ID != "p-0123abcd" || p.Pairing.Phase != "pairing" {
		t.Fatalf("%+v %v", p, err)
	}
	f.Set(desk.PathBluetoothConfirm, desktest.Answer{Body: `{"v":1,"pairing":` + pairing("connecting", ``) + `}`})
	f.Set(desk.PathBluetoothCancel, desktest.Answer{Body: `{"v":1,"pairing":` + pairing("failed", `,"failure":"canceled"`) + `}`})
	device := `{"v":1,"device":` + keyboard + `}`
	f.Set(desk.PathBluetoothConnect, desktest.Answer{Body: device})
	f.Set(desk.PathBluetoothDisconnect, desktest.Answer{Body: strings.Replace(device, `"connected":true`, `"connected":false`, 1)})
	f.Set(desk.PathBluetoothForget, desktest.Answer{Body: `{"v":1}`})
	for name, call := range map[string]func() error{
		"confirm":    func() error { _, err := c.BluetoothConfirm(ctx, "p-0123abcd", false); return err },
		"cancel":     func() error { _, err := c.BluetoothCancel(ctx, "p-0123abcd"); return err },
		"connect":    func() error { _, err := c.BluetoothConnect(ctx, "F4:7A:11:0B:32:C9"); return err },
		"disconnect": func() error { _, err := c.BluetoothDisconnect(ctx, "F4:7A:11:0B:32:C9"); return err },
		"forget":     func() error { _, err := c.BluetoothForget(ctx, "F4:7A:11:0B:32:C9"); return err },
	} {
		if err := call(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	sent := map[string]map[string]any{}
	for _, call := range f.Calls() {
		var m map[string]any
		_ = json.Unmarshal([]byte(call.Body), &m)
		sent[call.Path] = m
	}
	if m := sent[desk.PathBluetoothPair]; m["v"] != float64(1) || m["address"] != "7C:C3:A1:5D:9B:14" || len(m) != 2 {
		t.Errorf("pair %v", m)
	}
	if m := sent[desk.PathBluetoothConfirm]; m["pairingId"] != "p-0123abcd" || m["accept"] != false || len(m) != 3 {
		t.Errorf("confirm %v", m)
	}
	if m := sent[desk.PathBluetoothForget]; m["address"] != "F4:7A:11:0B:32:C9" || len(m) != 2 {
		t.Errorf("forget %v", m)
	}

	before := len(f.Calls())
	for name, call := range map[string]func() error{
		"lower case":    func() error { _, err := c.BluetoothPair(ctx, "7c:c3:a1:5d:9b:14"); return err },
		"short":         func() error { _, err := c.BluetoothConnect(ctx, "7C:C3:A1:5D:9B"); return err },
		"dashes":        func() error { _, err := c.BluetoothForget(ctx, "7C-C3-A1-5D-9B-14"); return err },
		"empty":         func() error { _, err := c.BluetoothDisconnect(ctx, ""); return err },
		"pairing id":    func() error { _, err := c.BluetoothConfirm(ctx, "../state", true); return err },
		"no pairing id": func() error { _, err := c.BluetoothCancel(ctx, ""); return err },
	} {
		var de *desk.Error
		if err := call(); !errors.As(err, &de) || de.Status != 400 || de.Code != "bad_request" {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(f.Calls()) != before {
		t.Fatal("a refused request reached the runtime")
	}

	for path, code := range map[string]string{desk.PathBluetoothPair: "busy", desk.PathBluetoothScan: "no_bluetooth",
		desk.PathBluetoothConnect: "locked"} {
		f.Set(path, desktest.Answer{Status: 409, Body: `{"error":{"code":"` + code + `","message":"x"}}`})
	}
	var de *desk.Error
	if _, err := c.BluetoothPair(ctx, "7C:C3:A1:5D:9B:14"); !errors.As(err, &de) || de.Status != 409 || de.Code != "busy" {
		t.Fatal(err)
	}
	if _, err := c.BluetoothScan(ctx); !errors.As(err, &de) || de.Code != desk.ErrorNoBluetooth {
		t.Fatal(err)
	}
	if _, err := c.BluetoothConnect(ctx, "F4:7A:11:0B:32:C9"); !errors.As(err, &de) || de.Code != desk.ErrorLocked {
		t.Fatal(err)
	}
	// An answer that isn't one is the console's 502.
	f.Set(desk.PathBluetoothConfirm, desktest.Answer{Body: `{"v":1,"pairing":` + pairing("failed", ``) + `}`})
	if _, err := c.BluetoothConfirm(ctx, "p-0123abcd", true); !errors.As(err, &de) || de.Status != 502 {
		t.Fatal(err)
	}
	// The runtime with a broken answer: the log says so, and names no device (BT-10).
	f.Set(desk.PathBluetooth, desktest.Answer{Body: btAnswer(btState(adapterOn, `[`+strings.Replace(keyboard, "keyboard", "phone", 1)+`]`, `null`, `null`), locked)})
	if _, err := c.Bluetooth(ctx, desk.BluetoothCacheFor); err == nil {
		t.Fatal("a phone was taken")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.lines) == 0 {
		t.Fatal("nothing logged")
	}
	for _, line := range l.lines {
		if strings.Contains(line, "F4:7A") || strings.Contains(line, "7C:C3") || strings.Contains(line, "Keychron") {
			t.Fatalf("a device in the log: %q", line)
		}
	}
}
