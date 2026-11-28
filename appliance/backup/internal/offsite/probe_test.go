package offsite

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// The signature of AWS's own example (S3 docs, "Signature Calculations for the Authorization Header", GET Object).
func TestSignV4KnownAnswer(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	now, _ := time.Parse("20060102T150405Z", "20130524T000000Z")
	signV4(req, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "AKIAIOSFODNN7EXAMPLE",
		"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "s3", now)
	auth := req.Header.Get("Authorization")
	for _, want := range []string{"Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"} {
		if !strings.Contains(auth, want) {
			t.Fatalf("authorization lacks %s: %s", want, auth)
		}
	}
	if strings.Contains(auth, "wJalrXUtnFEMI") {
		t.Fatal("the secret travels")
	}
}

func TestParseS3AndRegion(t *testing.T) {
	for repo, want := range map[string]string{
		"s3:https://s3.eu-central-003.backblazeb2.com/my-backups/box":  "eu-central-003",
		"s3:https://fsn1.your-objectstorage.com/my-backups":            "fsn1",
		"s3:https://0123abcd.eu.r2.cloudflarestorage.com/my-backups/x": "auto",
		"s3:https://s3.eu-west-1.amazonaws.com/my-backups/a/b":         "eu-west-1",
		"s3:https://minio.example.com:9000/my-backups":                 "us-east-1",
	} {
		loc, err := ParseS3(repo)
		if err != nil {
			t.Fatalf("%s: %v", repo, err)
		}
		if got := Region(loc, ""); got != want {
			t.Fatalf("%s: region %s, want %s", repo, got, want)
		}
	}
	for _, bad := range []string{"s3:https://host", "s3:ftp://host/bucket", "s3:https://u:p@host/bucket",
		"s3:https://host/Bucket_Name", "s3:https://host/bucket?x=1", "rest:https://host/bucket", "s3:https://host/b/../x y"} {
		if _, err := ParseS3(bad); err == nil {
			t.Fatalf("%s parsed", bad)
		}
	}
	if loc, _ := ParseS3("s3:https://minio.example.com:9000/my-backups/a/b"); loc.Bucket != "my-backups" || loc.Prefix != "a/b" {
		t.Fatalf("loc: %+v", loc)
	}
}

// fakeS3 is a bucket of one name that takes one key, with switches for what it refuses.
type fakeS3 struct {
	mu       sync.Mutex
	objects  map[string][]byte
	bucket   string
	keyID    string
	region   string
	noDelete bool
	noRead   bool
	seen     []string
	// redirect answers a request signed for another region with this status and a Location at redirectTo (naming
	// the bucket's region in the header when regionHeader), as S3 does, instead of an error document.
	redirect     int
	redirectTo   string
	regionHeader bool
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fail := func(code int, s3code, region string) {
		w.WriteHeader(code)
		_ = xml.NewEncoder(w).Encode(struct {
			XMLName xml.Name `xml:"Error"`
			Code    string
			Message string
			Region  string `xml:",omitempty"`
		}{Code: s3code, Message: "refused", Region: region})
	}
	auth := r.Header.Get("Authorization")
	f.seen = append(f.seen, r.Method+" "+r.URL.Path+" "+auth)
	if !strings.Contains(auth, "Credential="+f.keyID+"/") {
		fail(http.StatusForbidden, "InvalidAccessKeyId", "")
		return
	}
	if !strings.Contains(auth, "/"+f.region+"/s3/") && f.redirect != 0 {
		w.Header().Set("Location", f.redirectTo+r.URL.Path)
		if f.regionHeader {
			w.Header().Set("X-Amz-Bucket-Region", f.region)
		}
		w.WriteHeader(f.redirect)
		return
	}
	if !strings.Contains(auth, "/"+f.region+"/s3/") {
		fail(http.StatusBadRequest, "AuthorizationHeaderMalformed", f.region)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	if parts[0] != f.bucket {
		fail(http.StatusNotFound, "NoSuchBucket", "")
		return
	}
	switch r.Method {
	case http.MethodPut:
		b, _ := io.ReadAll(r.Body)
		f.objects[parts[1]] = b
	case http.MethodGet:
		if f.noRead {
			fail(http.StatusForbidden, "AccessDenied", "")
			return
		}
		_, _ = w.Write(f.objects[parts[1]])
	case http.MethodDelete:
		if f.noDelete {
			fail(http.StatusForbidden, "AccessDenied", "")
			return
		}
		delete(f.objects, parts[1])
		w.WriteHeader(http.StatusNoContent)
	}
}

func probeAt(t *testing.T, f *fakeS3, bucket, keyID string) (string, error) {
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	loc, err := ParseS3("s3:http://" + u.Host + "/" + bucket + "/box")
	if err != nil {
		t.Fatal(err)
	}
	return (&Probe{Loc: loc, KeyID: keyID, Secret: "probe-secret-value"}).Run(context.Background())
}

// The check writes, reads back and deletes one file, and says plainly which step failed.
func TestProbeSteps(t *testing.T) {
	newFake := func() *fakeS3 {
		return &fakeS3{objects: map[string][]byte{}, bucket: "my-backups", keyID: "KEY1", region: "us-east-1"}
	}
	f := newFake()
	if region, err := probeAt(t, f, "my-backups", "KEY1"); err != nil || region != "us-east-1" {
		t.Fatalf("a good place: %s %v", region, err)
	}
	if len(f.objects) != 0 {
		t.Fatalf("the check left a file: %v", f.objects)
	}
	for _, s := range f.seen {
		if strings.Contains(s, "probe-secret-value") {
			t.Fatal("the secret travelled")
		}
	}
	// A storage in another region names it: the check asks again there and answers it.
	f = newFake()
	f.region = "eu-central-1"
	if region, err := probeAt(t, f, "my-backups", "KEY1"); err != nil || region != "eu-central-1" {
		t.Fatalf("another region: %s %v", region, err)
	}
	for name, c := range map[string]struct {
		edit   func(*fakeS3)
		bucket string
		key    string
		step   string
	}{
		"no such bucket": {nil, "other-bucket", "KEY1", StepBucket},
		"a wrong key":    {nil, "my-backups", "KEY2", StepKeys},
		"no reading":     {func(f *fakeS3) { f.noRead = true }, "my-backups", "KEY1", StepRead},
		"no deleting":    {func(f *fakeS3) { f.noDelete = true }, "my-backups", "KEY1", StepDelete},
	} {
		f := newFake()
		if c.edit != nil {
			c.edit(f)
		}
		_, err := probeAt(t, f, c.bucket, c.key)
		var oe *Error
		if !errors.As(err, &oe) || oe.Step != c.step || oe.Reason == "" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Nobody answers at the address.
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.Listener.Addr().String()
	srv.Close()
	loc, _ := ParseS3("s3:http://" + addr + "/my-backups")
	_, err := (&Probe{Loc: loc, KeyID: "KEY1", Secret: "x"}).Run(context.Background())
	var oe *Error
	if !errors.As(err, &oe) || oe.Step != StepReach {
		t.Fatalf("nobody there: %v", err)
	}
}

// A redirect is never followed: the region it names is asked for again at the same address, and one that names none
// fails the check. Nothing reaches the address it points to (plain http on this machine here).
func TestProbeNeverFollowsRedirects(t *testing.T) {
	var elsewhere []string
	var mu sync.Mutex
	other := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		elsewhere = append(elsewhere, r.Method+" "+r.URL.Path)
	}))
	defer other.Close()
	for _, code := range []int{http.StatusMovedPermanently, http.StatusTemporaryRedirect} {
		f := &fakeS3{objects: map[string][]byte{}, bucket: "my-backups", keyID: "KEY1", region: "eu-west-2",
			redirect: code, redirectTo: other.URL, regionHeader: true}
		if region, err := probeAt(t, f, "my-backups", "KEY1"); err != nil || region != "eu-west-2" {
			t.Fatalf("%d naming the region: %s %v", code, region, err)
		}
		f.regionHeader = false
		_, err := probeAt(t, f, "my-backups", "KEY1")
		var oe *Error
		if !errors.As(err, &oe) || oe.Step != StepRegion {
			t.Fatalf("%d naming no region: %v", code, err)
		}
	}
	if len(elsewhere) > 0 {
		t.Fatalf("a redirect was followed: %v", elsewhere)
	}
}
