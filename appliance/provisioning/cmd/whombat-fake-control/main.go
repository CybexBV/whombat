// Command whombat-fake-control is a test stand-in for control's `devices.register` endpoint
// (POST /v1/provisioning/devices, contracts 0.3.0) and `devices.registerClaimVerifier`
// (POST /v1/provisioning/devices/:device/claim-verifier, contracts 0.5.1). It verifies registrations with the same contracts
// binding control uses and answers 409 for any repeated serial, management key or content identity, like
// control. With --self-registration it also takes the credential-free `POST /v1/devices/self-register` of
// a self-installed appliance (CC-10: model "self-installed", origin "self"). For update tests it serves the
// manager's `update.assignment` from an assignment the test puts (`POST /test/assignment/{device}`, a signed
// assignment document as `tufrepo assign` writes it) and records `update.progress` (`GET /test/progress`); device
// requests are not verified there (NX-104). VM tests only; it keeps state in memory.
//
//	whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/token --env dev [--self-registration]
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/CybexBV/whombat/contracts/go/device"
)

type entry struct {
	Device  string                     `json:"device"`
	Origin  string                     `json:"origin"` // factory | self
	Retired bool                       `json:"retired"`
	Reg     *device.DeviceRegistration `json:"registration"`
}

func main() {
	listen := flag.String("listen", "127.0.0.1:4600", "address")
	tokenFile := flag.String("token-file", "", "file holding the provisioning token")
	env := flag.String("env", "dev", "environment")
	selfReg := flag.Bool("self-registration", false, "accept POST /v1/devices/self-register (control SELF_REGISTRATION=1)")
	flag.Parse()
	tok, err := os.ReadFile(*tokenFile)
	if err != nil {
		log.Fatal(err)
	}
	want := sha256.Sum256([]byte(strings.TrimSpace(string(tok))))
	var mu sync.Mutex
	var devices []entry
	// register verifies a signed registration and records it; origin is "factory" or "self".
	register := func(w http.ResponseWriter, r *http.Request, origin string) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		dec := json.NewDecoder(strings.NewReader(string(body)))
		dec.DisallowUnknownFields()
		var reg device.DeviceRegistration
		if err := dec.Decode(&reg); err != nil || reg.Validate() != nil || !device.VerifyRegistration(&reg) {
			http.Error(w, `{"error":"invalid_registration"}`, http.StatusBadRequest)
			return
		}
		if string(reg.Env) != *env {
			http.Error(w, `{"error":"wrong_environment"}`, http.StatusBadRequest)
			return
		}
		if origin == "self" && reg.Model != "self-installed" {
			http.Error(w, `{"error":"invalid_registration"}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		for _, e := range devices {
			o := e.Reg
			// CL-34: a serial is unique among live devices only; keys stay unique for ever.
			if (!e.Retired && o.HardwareSerial == reg.HardwareSerial) || o.ManagementPublicKey == reg.ManagementPublicKey ||
				o.ContentPublicKey == reg.ContentPublicKey || o.ManagementPublicKey == reg.ContentPublicKey ||
				o.ContentPublicKey == reg.ManagementPublicKey {
				log.Printf("conflict: serial %s", reg.HardwareSerial)
				http.Error(w, `{"error":"device_exists"}`, http.StatusConflict)
				return
			}
		}
		id := make([]byte, 8)
		_, _ = rand.Read(id)
		e := entry{Device: "dev_" + hex.EncodeToString(id), Origin: origin, Reg: &reg}
		devices = append(devices, e)
		log.Printf("registered %s (%s) serial %s peer %s", e.Device, origin, reg.HardwareSerial, reg.ContentPeerID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(device.DeviceRegistrationResponse{Device: e.Device, ApplianceRoute: "rt_" + hex.EncodeToString(id[:4]), Env: reg.Env})
	}
	http.HandleFunc("POST /v1/provisioning/devices", func(w http.ResponseWriter, r *http.Request) {
		got := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			http.Error(w, `{"error":"provisioning_auth"}`, http.StatusUnauthorized)
			return
		}
		register(w, r, "factory")
	})
	http.HandleFunc("POST /v1/devices/self-register", func(w http.ResponseWriter, r *http.Request) {
		if !*selfReg {
			http.Error(w, `{"error":"self_registration_disabled"}`, http.StatusForbidden)
			return
		}
		if r.Header.Get("Authorization") != "" {
			// A self-installed appliance holds no credential; anything else is a confused caller.
			http.Error(w, `{"error":"invalid_registration"}`, http.StatusBadRequest)
			return
		}
		register(w, r, "self")
	})
	verifiers := map[string]string{}
	http.HandleFunc("POST /v1/provisioning/devices/{device}/claim-verifier", func(w http.ResponseWriter, r *http.Request) {
		got := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			http.Error(w, `{"error":"provisioning_auth"}`, http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		v, err := device.ParseClaimVerifierRegistration(body)
		if err != nil {
			http.Error(w, `{"error":"invalid_claim_verifier"}`, http.StatusBadRequest)
			return
		}
		dev := r.PathValue("device")
		mu.Lock()
		defer mu.Unlock()
		known := false
		for _, e := range devices {
			known = known || e.Device == dev
		}
		switch {
		case !known:
			http.Error(w, `{"error":"device_unknown"}`, http.StatusNotFound)
		case verifiers[dev] == v.ClaimVerifier:
			_, _ = w.Write([]byte(`{"ok":true}`))
		case verifiers[dev] != "":
			http.Error(w, `{"error":"claim_verifier_exists"}`, http.StatusConflict)
		default:
			verifiers[dev] = v.ClaimVerifier
			log.Printf("claim verifier registered for %s", dev)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	})
	// Test hook: retire a device (as control's sweep does for an unclaimed self-registered one, CL-33).
	http.HandleFunc("POST /test/retire/{device}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		for i := range devices {
			if devices[i].Device == r.PathValue("device") {
				devices[i].Retired = true
				_, _ = w.Write([]byte(`{"ok":true}`))
				return
			}
		}
		http.NotFound(w, r)
	})
	http.HandleFunc("GET /test/devices", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(devices)
	})
	// Update assignments (CT-28): the latest one the test put per device, answered while its sequence is above the
	// manager's lastSequence (the manager polls every pollSec).
	assignments := map[string]json.RawMessage{}
	var progress []json.RawMessage
	http.HandleFunc("POST /test/assignment/{device}", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 256*1024))
		if !json.Valid(body) {
			http.Error(w, `{"error":"invalid_json"}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		assignments[r.PathValue("device")] = body
		log.Printf("assignment for %s", r.PathValue("device"))
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	deviceOp := func(r *http.Request) (*device.DeviceRequestEnvelope, error) {
		var env device.DeviceRequestEnvelope
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		return &env, json.Unmarshal(body, &env)
	}
	http.HandleFunc("POST /v1/device/update.assignment", func(w http.ResponseWriter, r *http.Request) {
		env, err := deviceOp(r)
		var req device.UpdateAssignmentRequest
		if err != nil || json.Unmarshal(env.Body, &req) != nil {
			http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		raw := assignments[env.Device]
		mu.Unlock()
		var a struct {
			Payload struct {
				Sequence int64 `json:"sequence"`
			} `json:"payload"`
		}
		w.Header().Set("Content-Type", "application/json")
		if raw == nil || json.Unmarshal(raw, &a) != nil || a.Payload.Sequence <= req.LastSequence {
			_, _ = w.Write([]byte(`{"result":"none","assignment":null,"nextCheckS":5}`))
			return
		}
		_, _ = w.Write([]byte(`{"result":"assigned","assignment":` + string(raw) + `,"nextCheckS":5}`))
	})
	http.HandleFunc("POST /v1/device/update.progress", func(w http.ResponseWriter, r *http.Request) {
		env, err := deviceOp(r)
		if err != nil {
			http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}
		mu.Lock()
		progress = append(progress, env.Body)
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	})
	http.HandleFunc("GET /test/progress", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(progress)
	})
	log.Printf("fake control on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, nil))
}
