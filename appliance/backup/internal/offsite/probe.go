package offsite

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Steps of setting up a second place and of a copy: what failed, for the person's sentence (the runtime says it in
// the person's language from the step; Reasons are the English ones).
const (
	StepReach      = "reach"      // the storage didn't answer at that address
	StepBucket     = "bucket"     // no bucket with that name
	StepKeys       = "keys"       // the access key or its secret was refused
	StepRegion     = "region"     // the bucket is in another region than the address says
	StepWrite      = "write"      // the key can't save files there
	StepRead       = "read"       // the key can't read them back
	StepDelete     = "delete"     // the key can't delete (restic needs it for its locks, Whombat to clear old copies)
	StepRepository = "repository" // the folder holds backups this Whombat's password doesn't open
	StepSame       = "same"       // it is where the backups go already
	StepPair       = "pair"       // the main place needs other credentials of the same kind (two buckets, two keys)
	StepMain       = "main"       // the main place's backups couldn't be read
	StepCopy       = "copy"       // the copy itself stopped
)

// Reasons are the English sentences of each step.
var Reasons = map[string]string{
	StepReach:      "Whombat couldn't reach the storage at that address. Check the address.",
	StepBucket:     "There is no bucket with that name there. Check its name, or make the bucket first.",
	StepKeys:       "The storage didn't accept the access key. Check the key and its secret.",
	StepRegion:     "The storage says the bucket is in another region. Check the address.",
	StepWrite:      "The key can't save files in that bucket. Give it permission to write.",
	StepRead:       "The key can't read files back from that bucket. Give it permission to read.",
	StepDelete:     "The key can't delete files in that bucket. Whombat needs that to clear old copies; give it permission to delete.",
	StepRepository: "That folder already holds backups this Whombat can't open. Choose another folder.",
	StepSame:       "That's where your backups go already. Choose another place for the copy.",
	StepPair:       "Your backups already go to a bucket with another key. Whombat can keep a copy in a second bucket only with the same key.",
	StepMain:       "Whombat couldn't read the backups at their main place, so nothing was copied.",
	StepCopy:       "Copying the backups to the second place stopped before it finished.",
}

// Error is a step that failed, with the person's sentence and what went wrong technically (logs only).
type Error struct {
	Step   string
	Reason string
	Err    error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Reason + " (" + e.Err.Error() + ")"
	}
	return e.Reason
}

func (e *Error) Unwrap() error { return e.Err }

func stepErr(step string, err error) *Error {
	return &Error{Step: step, Reason: Reasons[step], Err: err}
}

// S3Location is where an s3: repository is: the endpoint (scheme and host), the bucket and the folder in it.
type S3Location struct {
	Scheme string
	Host   string
	Bucket string
	Prefix string
}

var (
	bucketRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	prefixRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
)

// ParseS3 reads "s3:https://host[:port]/bucket[/folder]" (the form the backup service takes for any bucket).
func ParseS3(repo string) (S3Location, error) {
	u, err := url.Parse(strings.TrimPrefix(repo, "s3:"))
	if !strings.HasPrefix(repo, "s3:") || err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return S3Location{}, errors.New("an S3 place is s3:https://host/bucket/folder")
	}
	parts := strings.SplitN(strings.Trim(u.Path, "/"), "/", 2)
	loc := S3Location{Scheme: u.Scheme, Host: u.Host, Bucket: parts[0]}
	if len(parts) == 2 {
		loc.Prefix = parts[1]
	}
	if !bucketRe.MatchString(loc.Bucket) {
		return S3Location{}, errors.New("a bucket's name is 3 to 63 lowercase letters, digits, dots and dashes")
	}
	if loc.Prefix != "" && !prefixRe.MatchString(loc.Prefix) {
		return S3Location{}, errors.New("the folder in the bucket is letters, digits, dots, dashes and underscores")
	}
	return loc, nil
}

// regionOf is the region an endpoint's host names (Backblaze, Hetzner, AWS, Cloudflare R2), "" when it names none.
func regionOf(host string) string {
	h := strings.ToLower(host)
	if i := strings.LastIndex(h, ":"); i >= 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	for _, re := range regionPatterns {
		if m := re.FindStringSubmatch(h); m != nil {
			return m[1]
		}
	}
	if strings.HasSuffix(h, ".r2.cloudflarestorage.com") {
		return "auto"
	}
	return ""
}

var regionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^s3\.([a-z0-9-]+)\.backblazeb2\.com$`),
	regexp.MustCompile(`^([a-z0-9-]+)\.your-objectstorage\.com$`),
	regexp.MustCompile(`^s3[.-]([a-z0-9-]+)\.amazonaws\.com$`),
	regexp.MustCompile(`^s3\.dualstack\.([a-z0-9-]+)\.amazonaws\.com$`),
}

// Region is the region requests to loc are signed for: the one given, else the one its host names, else us-east-1
// (S3's default, which most other storage takes).
func Region(loc S3Location, given string) string {
	if given != "" {
		return given
	}
	if r := regionOf(loc.Host); r != "" {
		return r
	}
	return "us-east-1"
}

/* AWS Signature Version 4 ------------------------------------------------------------------------------------- */

// signV4 signs req for service in region (AWS Signature Version 4): the headers present when it is called, with host,
// x-amz-date and the payload's hash added; the secret itself never travels.
func signV4(req *http.Request, payloadHash, keyID, secret, region, service string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	req.Header.Set("X-Amz-Date", amzDate)
	if service == "s3" {
		req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	}
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	names := []string{"host"}
	values := map[string]string{"host": host}
	for k, v := range req.Header {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "user-agent" {
			continue
		}
		names = append(names, lk)
		values[lk] = strings.Join(strings.Fields(strings.Join(v, ",")), " ")
	}
	sort.Strings(names)
	var ch strings.Builder
	for _, n := range names {
		ch.WriteString(n + ":" + values[n] + "\n")
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join([]string{req.Method, canonicalPath(req.URL), canonicalQuery(req.URL), ch.String(), signed,
		payloadHash}, "\n")
	scope := day + "/" + region + "/" + service + "/aws4_request"
	sum := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	k := hmacSHA256([]byte("AWS4"+secret), day)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, service)
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+keyID+"/"+scope+", SignedHeaders="+signed+
		", Signature="+sig)
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// canonicalPath encodes every path segment as SigV4 asks (unreserved characters as they are), keeping the slashes.
func canonicalPath(u *url.URL) string {
	p := u.EscapedPath()
	if p == "" {
		return "/"
	}
	raw, err := url.PathUnescape(p)
	if err != nil {
		raw = u.Path
	}
	segs := strings.Split(raw, "/")
	for i, s := range segs {
		segs[i] = sigEscape(s)
	}
	return strings.Join(segs, "/")
}

func canonicalQuery(u *url.URL) string {
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, sigEscape(k)+"="+sigEscape(v))
		}
	}
	return strings.Join(parts, "&")
}

func sigEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

/* The check before a place is saved --------------------------------------------------------------------------- */

// Probe is the check of an S3 place before it is saved: a small file written, read back and deleted with the
// person's key, each step answered by what the storage said.
type Probe struct {
	Loc    S3Location
	KeyID  string
	Secret string
	Region string // "" = Region(Loc, "")
	Client *http.Client
	Now    func() time.Time
}

// s3Error is the XML error document S3 answers.
type s3Error struct {
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
	Region  string `xml:"Region"`
}

// Run writes, reads back and deletes one small file in the folder, and answers the region that worked. A storage that
// names another region in its refusal is asked once more in that region.
func (p *Probe) Run(ctx context.Context) (string, error) {
	region := Region(p.Loc, p.Region)
	err := p.run(ctx, region)
	var pe *probeRegion
	if errors.As(err, &pe) && pe.region != "" && pe.region != region {
		region = pe.region
		err = p.run(ctx, region)
	}
	if errors.As(err, &pe) {
		return region, stepErr(StepRegion, errors.New(pe.msg))
	}
	return region, err
}

type probeRegion struct{ region, msg string }

func (e *probeRegion) Error() string { return "wrong region: " + e.msg }

func (p *Probe) run(ctx context.Context, region string) error {
	rnd := make([]byte, 8)
	_, _ = rand.Read(rnd)
	key := "whombat-check-" + hex.EncodeToString(rnd)
	if p.Loc.Prefix != "" {
		key = p.Loc.Prefix + "/" + key
	}
	body := []byte("Whombat checks it can keep backups here. This file is removed at once.\n")
	if err := p.do(ctx, region, http.MethodPut, key, body, StepWrite, nil); err != nil {
		return err
	}
	var got []byte
	if err := p.do(ctx, region, http.MethodGet, key, nil, StepRead, &got); err != nil {
		return err
	}
	if !bytes.Equal(got, body) {
		return stepErr(StepRead, errors.New("the file read back differs from the one written"))
	}
	return p.do(ctx, region, http.MethodDelete, key, nil, StepDelete, nil)
}

func (p *Probe) do(ctx context.Context, region, method, key string, body []byte, step string, out *[]byte) error {
	u := url.URL{Scheme: p.Loc.Scheme, Host: p.Loc.Host, Path: "/" + p.Loc.Bucket + "/" + key}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return stepErr(StepReach, err)
	}
	if body == nil {
		req.Body = http.NoBody
	}
	req.ContentLength = int64(len(body))
	sum := sha256.Sum256(body)
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	signV4(req, hex.EncodeToString(sum[:]), p.KeyID, p.Secret, region, "s3", now())
	hc := http.Client{Timeout: 30 * time.Second}
	if p.Client != nil {
		hc = *p.Client
	}
	// A redirect is the storage's answer, never followed: S3 names the bucket's region with one, and following one
	// could take the key's signed requests to another address, over plain http too.
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := hc.Do(req)
	if err != nil {
		return stepErr(StepReach, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out != nil {
			*out = b
		}
		return nil
	}
	var e s3Error
	_ = xml.Unmarshal(b, &e)
	detail := fmt.Errorf("HTTP %d %s: %s", resp.StatusCode, e.Code, strings.TrimSpace(e.Message))
	// The region an answer names: in its body, else in the header S3 sets on a redirect.
	named := e.Region
	if named == "" {
		named = resp.Header.Get("X-Amz-Bucket-Region")
	}
	switch e.Code {
	case "NoSuchBucket":
		return stepErr(StepBucket, detail)
	case "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "InvalidSecurity":
		return stepErr(StepKeys, detail)
	case "AuthorizationHeaderMalformed", "IllegalLocationConstraintException", "InvalidRegion":
		return &probeRegion{region: named, msg: detail.Error()}
	case "PermanentRedirect", "IncorrectEndpoint", "TemporaryRedirect":
		return &probeRegion{region: named, msg: detail.Error()}
	}
	switch {
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		// Any other redirect: the bucket is reached at another address, maybe in another region.
		return &probeRegion{region: named, msg: detail.Error()}
	case resp.StatusCode == http.StatusNotFound && method != http.MethodGet:
		return stepErr(StepBucket, detail)
	case resp.StatusCode == http.StatusUnauthorized:
		return stepErr(StepKeys, detail)
	}
	return stepErr(step, detail)
}
