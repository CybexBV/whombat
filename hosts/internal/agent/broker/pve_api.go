package broker

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// pveAPI is a client for the local Proxmox VE API with one API token
// ("USER@REALM!TOKENID=SECRET", never logged). Parameters are sent
// form-encoded (query string for GET and DELETE); answers are PVE's
// {"data": ...} envelope.
type pveAPI struct {
	base  string // https://127.0.0.1:8006/api2/json
	token string
	hc    *http.Client
}

func newPVEAPI(base, token string) (*pveAPI, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("pve url %q: invalid", base)
	}
	tr := &http.Transport{
		TLSClientConfig:     pveAPITLSConfig(u.Hostname()),
		Proxy:               nil,
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	}
	return &pveAPI{base: strings.TrimRight(base, "/"), token: token, hc: &http.Client{Transport: tr, Timeout: 60 * time.Second}}, nil
}

// pveAPITLSConfig is the collector's TLS setup (collect.pveTLSConfig):
// the certificate is verified against the system and cluster CAs; for a
// loopback URL the node's own certificate files are accepted too, and any
// certificate when those are unreadable (the connection never leaves the
// host).
func pveAPITLSConfig(host string) *tls.Config {
	loopback := host == "localhost"
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if b, err := os.ReadFile("/etc/pve/pve-root-ca.pem"); err == nil {
		pool.AppendCertsFromPEM(b)
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // verified in VerifyConnection
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("pve: no server certificate")
			}
			leaf := cs.PeerCertificates[0]
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, verr := leaf.Verify(x509.VerifyOptions{Roots: pool, Intermediates: inter, DNSName: host})
			if verr == nil || !loopback {
				return verr
			}
			readable := false
			for _, f := range []string{"/etc/pve/local/pveproxy-ssl.pem", "/etc/pve/local/pve-ssl.pem"} {
				b, err := os.ReadFile(f)
				if err != nil {
					continue
				}
				readable = true
				if blk, _ := pem.Decode(b); blk != nil && bytes.Equal(blk.Bytes, leaf.Raw) {
					return nil
				}
			}
			if !readable {
				return nil
			}
			return verr
		},
	}
}

// pveAPIError is a failed API call: the HTTP status, PVE's message (the
// reason phrase or the body's "message") and, for parameter errors (HTTP
// 400), the per-parameter messages.
type pveAPIError struct {
	Status int
	Msg    string
	Fields map[string]string
}

func (e *pveAPIError) Error() string { return e.Msg }

func apiStatus(err error) int {
	var ae *pveAPIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

func (a *pveAPI) get(ctx context.Context, path string, q url.Values, out any) error {
	return a.do(ctx, http.MethodGet, path, q, out)
}

func (a *pveAPI) post(ctx context.Context, path string, form url.Values, out any) error {
	return a.do(ctx, http.MethodPost, path, form, out)
}

func (a *pveAPI) put(ctx context.Context, path string, form url.Values, out any) error {
	return a.do(ctx, http.MethodPut, path, form, out)
}

func (a *pveAPI) delete(ctx context.Context, path string, q url.Values, out any) error {
	return a.do(ctx, http.MethodDelete, path, q, out)
}

// do sends one request. out receives the "data" member (nil: ignored).
func (a *pveAPI) do(ctx context.Context, method, path string, params url.Values, out any) error {
	target := a.base + path
	var body io.Reader
	if method == http.MethodGet || method == http.MethodDelete {
		if len(params) > 0 {
			target += "?" + params.Encode()
		}
	} else {
		body = strings.NewReader(params.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "PVEAPIToken="+a.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return codeErr(CodeTimeout, "the Proxmox VE API did not answer in time")
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // the URL is noise
		}
		return &pveAPIError{Msg: "Proxmox VE API: " + err.Error()}
	}
	defer resp.Body.Close()
	var env struct {
		Data    json.RawMessage   `json:"data"`
		Errors  map[string]string `json:"errors"`
		Message string            `json:"message"`
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 32<<20))
	derr := dec.Decode(&env)
	if resp.StatusCode != http.StatusOK {
		msg := env.Message
		if msg == "" {
			// PVE puts the error into the reason phrase.
			msg = strings.TrimSpace(strings.TrimPrefix(resp.Status, strconv.Itoa(resp.StatusCode)))
		}
		e := &pveAPIError{Status: resp.StatusCode, Msg: firstLine(msg, 500)}
		if len(env.Errors) > 0 {
			e.Fields = make(map[string]string, len(env.Errors))
			for k, v := range env.Errors {
				e.Fields[k] = firstLine(v, 500)
			}
		}
		return e
	}
	if derr != nil {
		return &pveAPIError{Msg: "Proxmox VE API " + path + ": " + derr.Error()}
	}
	if out == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return &pveAPIError{Msg: "Proxmox VE API " + path + ": unexpected answer: " + err.Error()}
	}
	return nil
}

// firstLine trims s to its first non-empty line, at most n bytes (on a
// UTF-8 boundary).
func firstLine(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if len(s) > n {
		s = strings.ToValidUTF8(s[:n], "")
	}
	return s
}

// apiFail maps an error of a manage operation to its response: agent
// validation errors keep their code, PVE errors are mapped to the codes of
// docs/MANAGE.md 2.3, everything else is platform_error. Secret values
// (passwords) are blanked out of every message.
func apiFail(err error, secrets ...string) proto.ManageResponse {
	var r proto.ManageResponse
	var fe *fieldsError
	var ae *pveAPIError
	switch {
	case errors.As(err, &fe):
		r = proto.ManageResponse{Code: fe.code, Message: fe.msg, FieldErrors: fe.fields}
	case errors.As(err, &ae):
		r = pveErrorResponse(ae)
	default:
		code, msg := errCode(err, CodePlatformError)
		r = proto.ManageResponse{Code: code, Message: firstLine(msg, 500)}
	}
	r.Message = scrub(r.Message, secrets)
	for k, v := range r.FieldErrors {
		r.FieldErrors[k] = scrub(v, secrets)
	}
	return r
}

func pveErrorResponse(e *pveAPIError) proto.ManageResponse {
	msg := e.Msg
	if msg == "" {
		msg = "Proxmox VE API error " + strconv.Itoa(e.Status)
	}
	low := strings.ToLower(msg)
	r := proto.ManageResponse{Code: CodePlatformError, Message: msg}
	switch {
	case e.Status == http.StatusBadRequest && len(e.Fields) > 0:
		r.Code, r.FieldErrors = proto.CodeInvalidValue, e.Fields
		if keys := sortedKeys(e.Fields); len(keys) > 0 {
			r.Message = firstLine(msg+" ("+keys[0]+": "+e.Fields[keys[0]]+")", 500)
		}
	case e.Status == http.StatusUnauthorized:
		r.Message = "Proxmox VE refused the agent's manage token"
	case strings.Contains(low, "detected modified configuration") || strings.Contains(low, "digest mismatch"):
		r.Code = proto.CodeDigestMismatch
	case strings.Contains(low, "can't lock file") || strings.Contains(low, "is locked"):
		r.Code = proto.CodeLocked
	case e.Status == http.StatusForbidden:
		r.Code = proto.CodeNotAllowed
	case strings.Contains(low, "already exists"):
		r.Code = proto.CodeExists
	case e.Status == http.StatusNotFound || strings.Contains(low, "does not exist") || strings.Contains(low, "no such"):
		r.Code = proto.CodeNotFound
	case e.Status == http.StatusNotImplemented:
		r.Code = CodeUnsupported
	}
	return r
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// scrub replaces every occurrence of a secret in s.
func scrub(s string, secrets []string) string {
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, maskedSecret)
		}
	}
	return s
}

// maskedSecret stands for a password in configurations, changes and
// messages (PVE masks cipassword the same way).
const maskedSecret = "**********"

// fieldsError is an agent-side validation error with per-key messages.
type fieldsError struct {
	code, msg string
	fields    map[string]string
}

func (e *fieldsError) Error() string { return e.msg }

// fieldErr refuses one key: code is invalid_value or not_allowed.
func fieldErr(code, key, msg string) error {
	return &fieldsError{code: code, msg: key + ": " + msg, fields: map[string]string{key: msg}}
}

// pveValue decodes a JSON string, number or boolean into its text (PVE
// returns "1024" or 1024 for the same key depending on the version).
type pveValue string

func (v *pveValue) UnmarshalJSON(b []byte) error {
	switch {
	case len(b) > 0 && b[0] == '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*v = pveValue(s)
	case string(b) == "true":
		*v = "1"
	case string(b) == "false":
		*v = "0"
	case string(b) == "null":
		*v = ""
	default:
		*v = pveValue(strings.TrimSpace(string(b)))
	}
	return nil
}

func (v pveValue) bool() bool { return v != "" && v != "0" }

func (v pveValue) int() int { n, _ := strconv.Atoi(string(v)); return n }

func (v pveValue) uint() uint64 {
	if n, err := strconv.ParseUint(string(v), 10, 64); err == nil {
		return n
	}
	f, _ := strconv.ParseFloat(string(v), 64)
	if f > 0 {
		return uint64(f)
	}
	return 0
}

// ---- UPIDs -------------------------------------------------------------------

// upidRe is PVE::Tools::upid_decode's format,
// UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:, without
// the characters that would mean something in a URL path (real task ids
// have none).
var upidRe = regexp.MustCompile(`^UPID:([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/?#%\\]+):([^:\s/?#%\\]*):([^:\s/?#%\\]+):$`)

// pveUPID is a decoded task id.
type pveUPID struct {
	Node, Type, ID, User string
	Start                time.Time
}

func parseUPID(s string) (pveUPID, bool) {
	m := upidRe.FindStringSubmatch(s)
	if m == nil {
		return pveUPID{}, false
	}
	start, _ := strconv.ParseInt(m[5], 16, 64)
	return pveUPID{Node: m[1], Type: m[6], ID: m[7], User: m[8], Start: time.Unix(start, 0).UTC()}, true
}

// taskAnswer is the answer of an operation that may have started a task:
// OK, with Task when PVE returned a UPID.
func taskAnswer(upid string) proto.ManageResponse {
	r := proto.ManageResponse{OK: true}
	if _, ok := parseUPID(upid); ok {
		r.Task = &proto.TaskRef{ID: upid}
	}
	return r
}
