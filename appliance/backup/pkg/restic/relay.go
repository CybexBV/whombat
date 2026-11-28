package restic

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// maxSocketPath is the longest path a unix socket may have (sun_path less its terminating zero).
const maxSocketPath = 107

// startRelay serves src, a REST repository over https, on a unix socket in a private folder under dir and returns the
// repository restic reaches it by (`rest:http+unix://<socket>:<path>`). The relay forwards each request as it came
// (restic's own credentials in it) and reaches the place over TLS trusting only src's authority: its private CA when it
// has one, else the system's roots. stop closes the relay and removes the folder.
func startRelay(src Repo, dir string) (repository string, stop func(), err error) {
	u, err := url.Parse(strings.TrimPrefix(src.Repository, "rest:"))
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", nil, errors.New("restic copy: the source isn't a REST server over https")
	}
	roots, err := x509.SystemCertPool()
	if src.CACert != "" {
		roots, err = x509.NewCertPool(), nil
		b, rerr := os.ReadFile(src.CACert)
		if rerr != nil {
			return "", nil, rerr
		}
		if !roots.AppendCertsFromPEM(b) {
			return "", nil, errors.New("restic copy: the source's CA certificate doesn't parse")
		}
	}
	if err != nil {
		return "", nil, err
	}
	tmp, err := os.MkdirTemp(dir, ".copy-relay-")
	if err != nil {
		return "", nil, err
	}
	sock := filepath.Join(tmp, "s")
	if len(sock) > maxSocketPath {
		_ = os.RemoveAll(tmp)
		return "", nil, fmt.Errorf("restic copy: the relay's socket path %s is too long", sock)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		_ = os.RemoveAll(tmp)
		return "", nil, err
	}
	place := &url.URL{Scheme: u.Scheme, Host: u.Host}
	srv := &http.Server{Handler: &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(place)
			pr.Out.Host = place.Host
		},
		// No proxy from this process's environment: restic, which reached the place before, gets none either.
		Transport: &http.Transport{
			TLSClientConfig:   &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
			ForceAttemptHTTP2: true,
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "the relay couldn't reach the place: "+err.Error(), http.StatusBadGateway)
		},
	}}
	go func() { _ = srv.Serve(ln) }()
	stop = func() {
		_ = srv.Close()
		_ = os.RemoveAll(tmp)
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return "rest:http+unix://" + sock + ":" + path, stop, nil
}
