package local

import "testing"

// The manager validates a runtime push with its preview (CT-286): any script on one line, length in code points.
func TestRuntimePushPreview(t *testing.T) {
	const base = `{"kind":"message","ref":"aaaaaaaaaaaaaaaaaaaaaa","handles":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"ttlS":60`
	ok := []string{
		base + `}`,
		base + `,"preview":{"title":"Banjo · #général","body":"“Klaar” — PR #42 🎉 日本語"}}`,
		base + `,"preview":{"title":"Banjo","body":""},"clear":false}`,
	}
	for _, in := range ok {
		if _, err := ParseRuntimePushRequest([]byte(in)); err != nil {
			t.Errorf("refused %s: %v", in, err)
		}
	}
	bad := []string{
		base + `,"preview":{"title":"Banjo","body":"a\nb"}}`,
		base + `,"preview":{"title":"Banjo","body":"a​b"}}`,
		base + `,"preview":{"title":"","body":"x"}}`,
		base + `,"preview":{"title":"Banjo","body":"x","more":1}}`,
	}
	for _, in := range bad {
		if _, err := ParseRuntimePushRequest([]byte(in)); err == nil {
			t.Errorf("accepted %s", in)
		}
	}
}
