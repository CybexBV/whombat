package dest

import (
	"errors"
	"testing"
)

// Finding 5: plain http sends the REST password (and S3 traffic) in clear; only a literal address on the
// owner's own network may use it.
func TestPlainHTTPOnlyToPrivateAddresses(t *testing.T) {
	for _, repo := range []string{
		"rest:http://10.0.0.5:8000/box/", "rest:http://192.168.1.20:8000/box/", "rest:http://172.20.0.3/box/",
		"rest:http://127.0.0.1:4730/box/", "rest:http://[::1]:8000/box/", "rest:http://[fd00::5]:8000/box/",
		"rest:http://169.254.10.1/box/", "rest:http://[fe80::1]:8000/box/", "rest:https://backup.example.com/box/",
	} {
		if _, err := validate(Request{Repository: repo, RESTUser: "u", RESTPassword: "p"}); err != nil {
			t.Fatalf("%s refused: %v", repo, err)
		}
	}
	if _, err := validate(Request{Repository: "s3:http://192.168.1.20:9000/bucket", S3AccessKeyID: "A", S3SecretAccessKey: "s"}); err != nil {
		t.Fatal(err)
	}
	for _, r := range []Request{
		{Repository: "rest:http://backup.example.com:8000/box/", RESTUser: "u", RESTPassword: "p"},
		{Repository: "rest:http://nas.local:8000/box/", RESTUser: "u", RESTPassword: "p"},
		{Repository: "rest:http://8.8.8.8:8000/box/"},
		{Repository: "rest:http://[2001:db8::1]:8000/box/"},
		{Repository: "s3:http://s3.example.com/bucket", S3AccessKeyID: "A", S3SecretAccessKey: "s"},
		{Repository: "s3:http://100.64.0.1/bucket", S3AccessKeyID: "A", S3SecretAccessKey: "s"},
	} {
		_, err := validate(r)
		var ie *InputError
		if !errors.As(err, &ie) {
			t.Fatalf("%s accepted over plain http", r.Repository)
		}
	}
}
