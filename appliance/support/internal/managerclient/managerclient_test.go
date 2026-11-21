package managerclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type call struct {
	method, path string
	body         []byte
}

func serve(t *testing.T, h func(w http.ResponseWriter, r *http.Request)) (*Client, <-chan call) {
	t.Helper()
	dir, err := os.MkdirTemp("", "mc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "m.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	calls := make(chan call, 16)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls <- call{r.Method, r.URL.Path, b}
		h(w, r)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return New(sock), calls
}

const ticketJSON = `{"ticket":"eyJhbGciOiJFZERTQSJ9.e30.c2ln","expiresAt":1792000000,` +
	`"relay":{"worker":"wrk-1","url":"wss://relay.example","reassignAfter":1792000300},"channel":"app"}`

func TestTicketPostsEmptyObjectAndReadsTheTicketResponse(t *testing.T) {
	c, calls := serve(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, ticketJSON)
	})
	tk, err := c.Ticket(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if tk.Token != "eyJhbGciOiJFZERTQSJ9.e30.c2ln" || tk.Worker != "wrk-1" || tk.URL != "wss://relay.example" ||
		!tk.ExpiresAt.Equal(time.Unix(1792000000, 0)) {
		t.Fatalf("%+v", tk)
	}
	got := <-calls
	if got.method != http.MethodPost || got.path != "/v1/support/ticket" || string(got.body) != "{}" {
		t.Fatalf("%+v", got)
	}
}

func TestTicketRefusesWhatIsntTheContract(t *testing.T) {
	c, _ := serve(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ticket":"x","expiresAt":"soon"}`)
	})
	if _, err := c.Ticket(context.Background()); err == nil {
		t.Fatal("a malformed ticket was accepted")
	}
}

func TestRefusalsCarryTheManagersCode(t *testing.T) {
	c, _ := serve(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"error":{"code":"forbidden","message":"this caller may not use this endpoint"}}`)
	})
	_, err := c.Ticket(context.Background())
	var me *Error
	if !errors.As(err, &me) || me.Status != 403 || me.Code != "forbidden" {
		t.Fatalf("%v", err)
	}
	if _, err := c.Hardware(context.Background()); !errors.As(err, &me) {
		t.Fatalf("%v", err)
	}
}

func TestLookReadsUseTheManagersRoutes(t *testing.T) {
	c, calls := serve(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"v":1,"x":true}`)
	})
	ctx := context.Background()
	for _, tc := range []struct {
		read         func(context.Context) (json.RawMessage, error)
		method, path string
		body         string
	}{
		{c.Hardware, "POST", "/v1/host/hardware", `{"v":1}`},
		{c.NetworkState, "POST", "/v1/network/state", `{"v":1}`},
		{c.UpdateStatus, "GET", "/v1/update/status", ``},
		{c.HostMetrics, "POST", "/v1/host/metrics", `{"v":1,"range":"hour","timeZone":"UTC"}`},
	} {
		got, err := tc.read(ctx)
		if err != nil || string(got) != `{"v":1,"x":true}` {
			t.Fatalf("%s: %s %v", tc.path, got, err)
		}
		cl := <-calls
		if cl.method != tc.method || cl.path != tc.path || string(cl.body) != tc.body {
			t.Fatalf("%+v, want %s %s %s", cl, tc.method, tc.path, tc.body)
		}
	}
}

func TestReadsRefuseNonObjects(t *testing.T) {
	c, _ := serve(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `["no"]`) })
	if _, err := c.UpdateStatus(context.Background()); err == nil {
		t.Fatal("a non-object was accepted")
	}
}
