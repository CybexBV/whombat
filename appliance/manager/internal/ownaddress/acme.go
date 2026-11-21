package ownaddress

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
)

// Orderer orders the box's certificate (MG-162): golang.org/x/crypto/acme, TLS-ALPN-01 only, ECDSA P-256, a new key
// for every order, an account without a contact address. The challenge is answered by the Responder, which the
// validator reaches through the door, the relay and the runtime.
type Orderer struct {
	Directory string
	// HTTP talks to the directory (nil: a client with a 60 s timeout).
	HTTP      *http.Client
	Store     *Store
	Responder *Responder
	Log       *slog.Logger
	// OrderTimeout bounds one order, validation and issuance included (0: 10 minutes).
	OrderTimeout time.Duration

	mu         sync.Mutex
	client     *acme.Client
	registered bool
}

// OrderError says why an order failed, in the contract's words (OwnAddressStateResponse.acme.error).
type OrderError struct {
	// Code: validation_failed, rate_limited, ca_unreachable or order_failed.
	Code string
	// RetryAfter is the CA's Retry-After on a 429 (0 otherwise).
	RetryAfter time.Duration
	Err        error
}

func (e *OrderError) Error() string { return e.Code + ": " + e.Err.Error() }
func (e *OrderError) Unwrap() error { return e.Err }

// classify turns the ACME client's errors into OrderErrors.
func classify(err error) *OrderError {
	var oe *OrderError
	if errors.As(err, &oe) {
		return oe
	}
	var ae *acme.AuthorizationError
	if errors.As(err, &ae) {
		return &OrderError{Code: "validation_failed", Err: err}
	}
	var ace *acme.Error
	if errors.As(err, &ace) {
		// acme.RateLimit looks only at an unwrapped error and the problem type; a 429 is the same thing.
		if ace.StatusCode == http.StatusTooManyRequests || strings.HasSuffix(strings.ToLower(ace.ProblemType), ":ratelimited") {
			wait := time.Duration(0)
			if ace.Header != nil {
				wait = retryAfterOf(ace.Header.Get("Retry-After"), time.Now())
			}
			return &OrderError{Code: "rate_limited", RetryAfter: wait, Err: err}
		}
		if ace.StatusCode >= 500 {
			return &OrderError{Code: "ca_unreachable", Err: err}
		}
		return &OrderError{Code: "order_failed", Err: err}
	}
	var ue *url.Error
	var ne net.Error
	if errors.As(err, &ue) || errors.As(err, &ne) || errors.Is(err, context.DeadlineExceeded) {
		return &OrderError{Code: "ca_unreachable", Err: err}
	}
	return &OrderError{Code: "order_failed", Err: err}
}

// retryBackoff keeps the ACME client's own retries short: a bad nonce or a 5xx is tried again three times within
// seconds; a 429 is never retried here, so its Retry-After reaches the service's loop, which waits it out.
func retryBackoff(n int, _ *http.Request, resp *http.Response) time.Duration {
	if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
		return 0
	}
	if n > 3 {
		return 0
	}
	return time.Duration(n) * time.Second
}

func (o *Orderer) log() *slog.Logger {
	if o.Log != nil {
		return o.Log
	}
	return slog.Default()
}

func (o *Orderer) acmeClient() (*acme.Client, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.client != nil {
		return o.client, nil
	}
	key, err := o.Store.AccountKey()
	if err != nil {
		return nil, fmt.Errorf("account key: %w", err)
	}
	hc := o.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	o.client = &acme.Client{Key: key, DirectoryURL: o.Directory, HTTPClient: hc, UserAgent: "whombat-manager",
		RetryBackoff: retryBackoff}
	return o.client, nil
}

// HTTPClientWithCA is the directory's client with extra roots from a PEM file (the pebble mode's test CA).
func HTTPClientWithCA(file string) (*http.Client, error) {
	if file == "" {
		return &http.Client{Timeout: 60 * time.Second}, nil
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(b) {
		return nil, fmt.Errorf("%s: no certificates", file)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	return &http.Client{Timeout: 60 * time.Second, Transport: tr}, nil
}

// Order orders one certificate for host and saves it (not yet current: the caller makes it so).
func (o *Orderer) Order(ctx context.Context, host string) (*Pair, error) {
	timeout := o.OrderTimeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cl, err := o.acmeClient()
	if err != nil {
		return nil, &OrderError{Code: "order_failed", Err: err}
	}
	o.mu.Lock()
	registered := o.registered
	o.mu.Unlock()
	if !registered {
		// No contact address: the box has nobody's email to give, and Let's Encrypt no longer mails anyway.
		if _, err := cl.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil && !errors.Is(err, acme.ErrAccountAlreadyExists) {
			return nil, classify(fmt.Errorf("register: %w", err))
		}
		o.mu.Lock()
		o.registered = true
		o.mu.Unlock()
	}
	order, err := cl.AuthorizeOrder(ctx, acme.DomainIDs(host))
	if err != nil {
		return nil, classify(fmt.Errorf("new order: %w", err))
	}
	// Later answers (the order fetched again, the finalize answer) may carry no Location: keep the URL from here.
	orderURL := order.URI
	for _, u := range order.AuthzURLs {
		if err := o.authorize(ctx, cl, u, host); err != nil {
			return nil, classify(err)
		}
	}
	order, err = cl.WaitOrder(ctx, orderURL)
	if err != nil {
		return nil, classify(fmt.Errorf("order: %w", err))
	}
	// A new key for every order (MG-162): a leaked old key never renews into the new certificate.
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, &OrderError{Code: "order_failed", Err: err}
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{DNSNames: []string{host}}, key)
	if err != nil {
		return nil, &OrderError{Code: "order_failed", Err: err}
	}
	chain, err := o.finalize(ctx, cl, order.FinalizeURL, orderURL, csr)
	if err != nil {
		return nil, classify(err)
	}
	if err := checkChain(chain, host, key); err != nil {
		return nil, &OrderError{Code: "order_failed", Err: err}
	}
	p, err := o.Store.SavePair(chain, key)
	if err != nil {
		return nil, &OrderError{Code: "order_failed", Err: fmt.Errorf("save: %w", err)}
	}
	return p, nil
}

func (o *Orderer) authorize(ctx context.Context, cl *acme.Client, authzURL, host string) error {
	z, err := cl.GetAuthorization(ctx, authzURL)
	if err != nil {
		return fmt.Errorf("authorization: %w", err)
	}
	if z.Status == acme.StatusValid {
		return nil
	}
	var chal *acme.Challenge
	for _, c := range z.Challenges {
		if c.Type == "tls-alpn-01" {
			chal = c
		}
	}
	if chal == nil {
		return errors.New("the CA offered no tls-alpn-01 challenge")
	}
	cert, err := cl.TLSALPN01ChallengeCert(chal.Token, z.Identifier.Value)
	if err != nil {
		return err
	}
	o.Responder.SetChallenge(host, &cert)
	defer o.Responder.ClearChallenge(host)
	if _, err := cl.Accept(ctx, chal); err != nil {
		return fmt.Errorf("accept: %w", err)
	}
	if _, err := cl.WaitAuthorization(ctx, z.URI); err != nil {
		return err
	}
	return nil
}

// finalize sends the CSR and returns the chain. x/crypto/acme waits on the finalize answer's Location header while
// the order is still processing; RFC 8555 doesn't require that header, and a CA that issues later (Pebble always,
// Let's Encrypt for some orders) sends none, so the call fails with an empty URL (spike/door.md, goal 1). Then the
// order's own URL is waited on and the chain fetched from it.
func (o *Orderer) finalize(ctx context.Context, cl *acme.Client, finalizeURL, orderURL string, csr []byte) ([][]byte, error) {
	chain, _, err := cl.CreateOrderCert(ctx, finalizeURL, csr, true)
	if err == nil {
		return chain, nil
	}
	var ae *acme.Error
	var oe *acme.OrderError
	if errors.As(err, &ae) || errors.As(err, &oe) || ctx.Err() != nil {
		return nil, fmt.Errorf("finalize: %w", err)
	}
	o.log().Info("own address: the finalize answer had no usable order URL; waiting on the order itself", "err", err)
	ord, werr := cl.WaitOrder(ctx, orderURL)
	if werr != nil {
		return nil, fmt.Errorf("finalize: %v; then the order: %w", err, werr)
	}
	if ord.Status != acme.StatusValid || ord.CertURL == "" {
		return nil, fmt.Errorf("finalize: %v; the order is %s", err, ord.Status)
	}
	chain, err = cl.FetchCert(ctx, ord.CertURL, true)
	if err != nil {
		return nil, fmt.Errorf("fetch the certificate: %w", err)
	}
	return chain, nil
}

// checkChain refuses a chain that isn't for host or not for the key this order made.
func checkChain(chain [][]byte, host string, key *ecdsa.PrivateKey) error {
	if len(chain) == 0 {
		return errors.New("the CA sent no certificate")
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return err
	}
	if err := leaf.VerifyHostname(host); err != nil {
		return err
	}
	pub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return errors.New("the certificate is not for this order's key")
	}
	return nil
}
