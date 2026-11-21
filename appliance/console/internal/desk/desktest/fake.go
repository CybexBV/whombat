// Package desktest is a fake of the runtime's desk socket for the console's tests: an HTTP server on a unix socket in a
// temporary directory that answers each path with what the test set, and records what it was sent.
package desktest

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Answer is a canned answer.
type Answer struct {
	Status      int
	ContentType string // default application/json
	Body        string
}

// Call is one request the fake got.
type Call struct {
	Method, Path, Body string
}

// Fake is the runtime's side of the socket.
type Fake struct {
	Socket string

	mu      sync.Mutex
	answers map[string]Answer
	calls   []Call
	hold    chan struct{} // non-nil: requests wait until it closes or they are cancelled
}

// Paired is a valid DeskState of a paired, locked screen with a summary (DK-03).
const Paired = `{"v":1,"now":"2026-10-20T09:41:00Z",
 "paired":{"person":{"name":"John","initial":"J","tone":2},"assistant":{"name":"Neo","face":"neo"},
  "timeZone":"Europe/Amsterdam","lockedView":"summary","night":"dim","quiet":false,"voice":true,"hasPin":true},
 "pairing":null,"lock":{"state":"locked"},
 "glance":{"status":{"text":"1 thing needs you."},"needsYou":{"count":1,"items":[]},"working":null,"done":[],
  "servers":[{"name":"pve-02","mark":"proxmox","state":"warn","note":"updating","cpu":{"value":41,"tone":"ok"}}],
  "moreServers":0,"tiles":[{"icon":"temperature","value":"21.5 °C","label":"Living room"}]},
 "power":{"source":"battery","percent":64,"charging":false,"minutesLeft":185,"chargeLimit":80,"since":"2026-10-20T09:30:00Z"},
 "talk":null}`

// NewBox is a valid DeskState of a new box (DK-17…DK-23): the screen paired itself, no PIN yet, nothing connected,
// so This Whombat shows where servers and tiles would be.
const NewBox = `{"v":1,"now":"2026-10-20T12:34:20Z",
 "paired":{"person":{"name":"John","initial":"J","tone":3},"assistant":{"name":"Neo","face":"neo"},
  "timeZone":"Europe/Amsterdam","lockedView":"summary","night":"dim","quiet":false,"voice":true,"hasPin":false},
 "pairing":null,"lock":{"state":"locked"},
 "glance":{"status":{"text":"All fine. I’m ready when you are.","more":"Connect a server or your home, and I’ll keep an eye on it here."},
  "needsYou":{"count":0,"items":[]},"working":null,"done":[],"servers":[],"moreServers":0,"tiles":[],
  "box":{"up":"up 2 h 14 min","cpu":{"percent":7,"cores":16,"tone":"ok"},
   "memory":{"percent":18,"used":{"value":"11.2","unit":"GB"},"total":"64 GB","tone":"ok"},
   "history":{"stepS":60,"cpu":[6,null,9,7],"memory":[17,null,18,18]},
   "storage":{"percent":13,"free":{"value":"812","unit":"GB"},"total":"937 GB","tone":"ok",
    "parts":[{"key":"whombat","value":"41 GB","percent":4},{"key":"agent","value":"84 GB","percent":9}]},
   "temp":{"value":46,"tone":"ok"},"network":{"down":"2.4 MB/s","up":"310 kB/s"}}},
 "power":{"source":"ac","percent":80,"charging":false,"minutesLeft":null,"chargeLimit":80,"since":null},
 "talk":null}`

// Fit is a valid DeskState of a glance with more than fits four across (0.104, DK-39, DK-41): four servers and the
// next four, two not sent at all, four tiles and the next two, and This Whombat beside them as `self`.
const Fit = `{"v":1,"now":"2026-10-20T12:34:20Z",
 "paired":{"person":{"name":"John","initial":"J","tone":3},"assistant":{"name":"Neo","face":"neo"},
  "timeZone":"Europe/Amsterdam","lockedView":"summary","night":"dim","quiet":false,"voice":true,"hasPin":true},
 "pairing":null,"lock":{"state":"locked"},
 "glance":{"status":{"text":"Everything’s fine."},"needsYou":{"count":0,"items":[]},"working":null,"done":[],
  "servers":[{"name":"pve-01","mark":"proxmox","state":"ok","note":"up 41 d"},
   {"name":"pve-02","mark":"proxmox","state":"ok","note":"up 41 d"},{"name":"blackbox","mark":"unraid","state":"ok","note":"up 9 d"},
   {"name":"the-falcon","mark":"linux","state":"ok","note":"updating"}],
  "moreServers":6,
  "extraServers":[{"name":"nas","mark":"truenas","state":"ok","note":"up 120 d","cpu":{"value":4,"tone":"ok"}},
   {"name":"pi-hole","mark":"raspberrypi","state":"ok","note":"up 3 d"},
   {"name":"backup-box","mark":"debian","state":"ok","note":"up 12 d"},{"name":"media","mark":"ubuntu","state":"ok","note":"up 6 d"}],
  "tiles":[{"icon":"temperature","value":"21.4 °C","label":"Living room"},{"icon":"heat","value":"Heating","label":"Heat pump"},
   {"icon":"sun","value":"3.2 kW","label":"Solar now"},{"icon":"lock","value":"Locked","label":"Front door"}],
  "extraTiles":[{"icon":"power","mark":"homeassistant","value":"412 W","label":"The house now"},
   {"icon":"water","value":"128 L","label":"Water today"}],
  "self":{"up":"up 2 h 14 min","cpu":{"percent":7,"cores":16,"tone":"ok"},
   "memory":{"percent":18,"used":{"value":"11.2","unit":"GB"},"total":"64 GB","tone":"ok"},
   "history":{"stepS":60,"cpu":[6,null,9,7],"memory":[17,null,18,18]},
   "storage":{"percent":13,"free":{"value":"812","unit":"GB"},"total":"937 GB","tone":"ok","parts":[]},
   "temp":{"value":46,"tone":"ok"},"network":null}},
 "power":null,"talk":null}`

// Found is a valid DeskState of a new box after its first scan (0.110, DF-01…DF-07): nothing connected, This Whombat
// as `box`, and three services found of four (`count`), the newest scan just finished.
const Found = `{"v":1,"now":"2026-10-20T12:34:20Z",
 "paired":{"person":{"name":"John","initial":"J","tone":3},"assistant":{"name":"Neo","face":"neo"},
  "timeZone":"Europe/Amsterdam","lockedView":"summary","night":"dim","quiet":false,"voice":true,"hasPin":true},
 "pairing":null,"lock":{"state":"locked"},
 "glance":{"status":{"text":"All fine. I’m ready when you are."},"needsYou":{"count":0,"items":[]},"working":null,
  "done":[],"servers":[],"moreServers":0,"tiles":[],
  "box":{"up":"up 12 min","cpu":{"percent":7,"cores":16,"tone":"ok"},
   "memory":{"percent":18,"used":{"value":"11.2","unit":"GB"},"total":"64 GB","tone":"ok"},
   "history":{"stepS":60,"cpu":[6,9],"memory":[17,18]},
   "storage":{"percent":13,"free":{"value":"812","unit":"GB"},"total":"937 GB","tone":"ok","parts":[]},
   "network":null},
  "found":{"scanning":false,"progress":null,"count":4,"finishedAt":"2026-10-20T12:33:50Z","items":[
   {"catalogId":"homeassistant","name":"Home Assistant","tagline":"Lights, heating and sensors","address":"10.100.0.5"},
   {"catalogId":"proxmox","name":"Proxmox VE","tagline":"Virtual machines and backups","address":"10.100.0.240"},
   {"catalogId":"synology","name":"Synology DSM","tagline":"Files, backups and photos","address":"10.100.1.30:5001"}]}},
 "power":null,"talk":null}`

// Idle is a valid DeskState of a screen that stays unlocked until Lock, with the camera looking for someone and seeing
// John (0.107, DK-72, DK-74): `lock.stays` and `presence`.
const Idle = `{"v":1,"now":"2026-10-20T12:34:20Z",
 "paired":{"person":{"name":"John","initial":"J","tone":3},"assistant":{"name":"Neo","face":"neo"},
  "timeZone":"Europe/Amsterdam","lockedView":"summary","night":"dim","quiet":false,"voice":true,"hasPin":true},
 "pairing":null,"lock":{"state":"unlocked","until":"2026-10-20T12:36:20Z","stays":true},
 "glance":{"status":{"text":"Everything’s fine."},"needsYou":{"count":0,"items":[]},"working":null,"done":[],
  "servers":[],"moreServers":0,"tiles":[{"icon":"temperature","value":"21.4 °C","label":"Living room"}]},
 "power":null,"talk":null,
 "presence":{"camera":true,"watching":true,"here":true}}`

// Servers is a valid DeskServersAnswer (0.115, DK-86): two cards with their ids and disks (one padded), three counted.
const Servers = `{"v":1,"servers":[
  {"id":"pve-01","name":" pve-01 ","mark":"proxmox","state":"ok","note":"up 41 d ","cpu":{"value":18,"tone":"ok"},
   "memory":{"value":54,"tone":"ok"},"disk":{"value":33,"tone":"ok"}},
  {"id":"nas","name":"nas","mark":"unraid","state":"ok","note":"up 120 d","disk":{"value":88,"tone":"warn"}}],
 "more":3}`

// ServerPage is a valid DeskServerPage of pve-01 (0.115, DK-83, mockup 2): a padded OS, a volume whose name is only a
// space, two guests and one alert.
const ServerPage = `{"v":1,"now":"2026-10-21T12:34:20Z",
 "server":{"id":"pve-01","name":"pve-01","mark":"proxmox","state":"ok","note":"up 41 d","cpu":{"value":18,"tone":"ok"}},
 "os":" Proxmox VE 9.0.10 ","up":"up 41 d",
 "cpu":{"percent":18,"cores":16,"load":"2.9","tone":"ok"},
 "memory":{"percent":54,"used":{"value":"69","unit":"GB"},"total":"128 GB","tone":"ok"},
 "disk":{"percent":33,"used":"1.2","total":"3.6 TB","tone":"ok"},
 "temp":{"value":46,"limit":85,"tone":"ok"},
 "history":{"range":"24h","stepS":900,"cpu":[10,null,61],"memory":[50,52,54],
  "cpuPeak":{"percent":61,"at":"2026-10-21T01:10:00Z"},"memoryAvg":52},
 "volumes":[{"name":"local-zfs","note":"nvme mirror","percent":41,"used":"0.8","total":"1.9 TB","tone":"ok"},
  {"name":" ","note":"","percent":3,"used":"1","total":"30 GB","tone":"ok"}],
 "guests":{"running":1,"off":1,"items":[{"name":"plex","kind":"vm","state":"running","cpu":22,"memory":"6.1 GB"},
  {"name":"win11-test","kind":"vm","state":"stopped","cpu":null,"memory":""}]},
 "network":{"down":"24 MB/s","up":"3.1 MB/s"},
 "alerts":{"count":1,"items":[{"tone":"warn","title":"The backup disk is 72 % full"}]}}`

// Session is a valid DeskTalkSession (0.108, DK-63): a question, the answer naming blackbox (with padding and a
// paragraph that is only a space), a message that is only a space, and the assistant's ask still waiting.
const Session = `{"v":1,"open":true,"messages":[
  {"id":"msg_Hq2v8LkP0aXz","from":"you","at":"2026-10-20T12:30:00Z","paragraphs":["Plex isn’t working, can you restart it?"],"talk":"dtk_q3Vx9LpA0dZk"},
  {"id":"msg_Jt5c1MnQ7bWy","from":"assistant","at":"2026-10-20T12:30:20Z",
   "paragraphs":["  Plex on blackbox stopped answering. "," ","• It usually comes back after a restart."],
   "more":true,"talk":"dtk_q3Vx9LpA0dZk","audio":true,
   "thing":{"name":"blackbox","mark":"unraid","state":"warn","note":"Plex down"}},
  {"id":"msg_Lw7f3QrT1dUv","from":"assistant","at":"2026-10-20T12:30:21Z","paragraphs":[" "]},
  {"id":"msg_Kr4d2NpS9cVx","from":"assistant","at":"2026-10-20T12:30:21Z","paragraphs":["Restart Plex on blackbox?"],
   "ask":{"number":12,"state":"waiting"}}],
 "earlier":0,"until":"2026-10-20T13:00:21Z"}`

// Network is a valid DeskNetworkAnswer (0.102, §2.5): a box on Wi-Fi “Home” with a cable unplugged, two saved
// networks, the screen locked (`mayChange` false).
const Network = `{"v":1,"network":{"online":true,"checkedAt":"2026-10-20T09:40:30Z",
  "wired":[{"interface":"enp0s20f0u2","connected":false}],
  "wifi":{"interface":"wlan0","state":"connected","ssid":"Home","signal":4,"address":"192.168.1.40",
   "saved":[{"ssid":"Home","security":"psk"},{"ssid":"Office","security":"psk"}]},
  "change":null},
 "mayChange":false,"why":"locked"}`

// Scan is a valid DeskWifiScanAnswer: the networks around that box, strongest first.
const Scan = `{"v":1,"scan":{"scannedAt":"2026-10-20T09:41:00Z","networks":[
  {"ssid":"Home","security":"psk","signal":4,"saved":true,"connected":true},
  {"ssid":"Lumio Guest","security":"open","signal":3,"saved":false,"connected":false},
  {"ssid":"Lumio","security":"enterprise","signal":2,"saved":false,"connected":false}]}}`

// Joining is a valid DeskWifiChangeAnswer: a join to “Office” as it starts.
const Joining = `{"v":1,"change":{"id":"c-0123abcd","kind":"join","ssid":"Office","phase":"applying",
  "deadline":"2026-10-20T09:43:00Z","previous":"Home"}}`

// Bluetooth is a valid desk Bluetooth answer (0.109, §2.4): an adapter, a keyboard connected with its battery,
// headphones paired but not connected, nothing looked for or paired now, the screen locked (`mayChange` false).
const Bluetooth = `{"v":1,"bluetooth":{"adapter":{"name":"whombat","powered":true},
  "devices":[{"address":"F4:7A:11:0B:32:C9","name":"Keychron K3","kind":"keyboard","connected":true,"battery":80},
   {"address":"AC:80:0A:5E:21:4D","name":"WH-1000XM5","kind":"headphones","connected":false}],
  "scan":null,"pairing":null},
 "mayChange":false,"why":"locked"}`

// BluetoothScan is a valid scan's answer: a mouse and a keyboard nearby, strongest first.
const BluetoothScan = `{"v":1,"scan":{"until":"2026-10-20T09:42:00Z","devices":[
  {"address":"D3:4C:91:7E:08:A2","name":"MX Master 3S","kind":"mouse","connected":false,"signal":4},
  {"address":"7C:C3:A1:5D:9B:14","name":"Magic Keyboard","kind":"keyboard","connected":false,"signal":2}]}}`

// Pairing is a valid pairing's answer: the Magic Keyboard as its pairing starts.
const Pairing = `{"v":1,"pairing":{"id":"p-0123abcd","address":"7C:C3:A1:5D:9B:14","name":"Magic Keyboard",
  "kind":"keyboard","phase":"pairing","deadline":"2026-10-20T09:42:30Z"}}`

// Start serves a fake on a socket in a new temporary directory; it stops with the test.
func Start(t *testing.T) *Fake {
	t.Helper()
	dir, err := os.MkdirTemp("", "desk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &Fake{Socket: filepath.Join(dir, "desk.sock"), answers: map[string]Answer{}}
	ln, err := net.Listen("unix", f.Socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		f.Release()
		_ = srv.Close()
	})
	f.Set("/v1/desk/state", Answer{Body: Paired})
	f.Set("/v1/desk/network", Answer{Body: Network})
	f.Set("/v1/desk/network/wifi/scan", Answer{Body: Scan})
	f.Set("/v1/desk/bluetooth", Answer{Body: Bluetooth})
	f.Set("/v1/desk/bluetooth/scan", Answer{Body: BluetoothScan})
	f.Set("/v1/desk/bluetooth/pair", Answer{Body: Pairing})
	return f
}

// Set makes path answer a.
func (f *Fake) Set(path string, a Answer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[path] = a
}

// Hold makes requests wait (a runtime that doesn't answer) until Release or until the client gives up.
func (f *Fake) Hold() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hold == nil {
		f.hold = make(chan struct{})
	}
}

// Release lets held requests go on.
func (f *Fake) Release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hold != nil {
		close(f.hold)
		f.hold = nil
	}
}

// Calls are the requests so far.
func (f *Fake) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

// CallsTo counts the requests to path.
func (f *Fake) CallsTo(path string) int {
	n := 0
	for _, c := range f.Calls() {
		if c.Path == path {
			n++
		}
	}
	return n
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, Call{Method: r.Method, Path: r.URL.Path, Body: string(body)})
	a, ok := f.answers[r.URL.Path]
	hold := f.hold
	f.mu.Unlock()
	if hold != nil {
		select {
		case <-hold:
		case <-r.Context().Done():
			return
		}
	}
	if !ok {
		a = Answer{Status: http.StatusNotFound, Body: `{"error":{"code":"not_found","message":"no such path"}}`}
	}
	if a.Status == 0 {
		a.Status = http.StatusOK
	}
	if a.ContentType == "" {
		a.ContentType = "application/json"
	}
	w.Header().Set("Content-Type", a.ContentType)
	w.WriteHeader(a.Status)
	_, _ = io.WriteString(w, a.Body)
}
