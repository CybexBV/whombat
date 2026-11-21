package canonjson

import "testing"

func TestCanonicalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"b":1,"a":[true,false,null]}`, `{"a":[true,false,null],"b":1}`},
		{` { "z" : "x\u0001y" , "a":"\"\\/" } `, `{"a":"\"\\/","z":"x\u0001y"}`},
		{`{"s":"  é€"}`, "{\"s\":\"  é€\"}"},
		{`{"n":-0}`, `{"n":0}`},
		{`{"n":1.0e3}`, `{"n":1000}`},
		{`{"n":9007199254740991}`, `{"n":9007199254740991}`},
		{`{"t":"\t\n\r\b\f"}`, `{"t":"\t\n\r\b\f"}`},
		// UTF-16 ordering: U+FB33 (one unit 0xFB33) sorts after U+1D11E (surrogates 0xD834..)
		{"{\"דּ\":1,\"\U0001D11E\":2}", "{\"\U0001D11E\":2,\"דּ\":1}"},
		{`[]`, `[]`},
		{`{}`, `{}`},
	}
	for _, c := range cases {
		got, err := Canonicalize([]byte(c.in))
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if string(got) != c.want {
			t.Errorf("%s: got %s want %s", c.in, got, c.want)
		}
	}
}

func TestRejects(t *testing.T) {
	for _, in := range []string{
		`{"n":1.5}`, `{"n":9007199254740992}`, `{"a":1,"a":2}`, `{"a":1} x`, "\"\xff\"", `{"s":"\ud800"}`, `1e400`,
	} {
		if _, err := Canonicalize([]byte(in)); err == nil {
			t.Errorf("%q: expected error", in)
		}
	}
}

func TestMarshalStruct(t *testing.T) {
	type s struct {
		B string `json:"b"`
		A int    `json:"a"`
		H string `json:"h"`
	}
	got, err := Marshal(s{B: "<&>", A: 3, H: "x"})
	if err != nil {
		t.Fatal(err)
	}
	// encoding/json escapes <&> as < etc.; canonical form must not.
	if string(got) != `{"a":3,"b":"<&>","h":"x"}` {
		t.Fatalf("got %s", got)
	}
	if !IsCanonical(got) {
		t.Fatal("not canonical")
	}
}
