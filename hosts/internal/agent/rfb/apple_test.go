package rfb

import (
	"bytes"
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
)

// rfc3526Group16 is the 4096-bit MODP prime: the size macOS Screen Sharing
// uses (a 512-byte key).
const rfc3526Group16 = "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
	"EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
	"EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
	"83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
	"E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
	"15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
	"ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
	"BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D7" +
	"88719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6" +
	"287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA9" +
	"93B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF"

// fakeApple is macOS Screen Sharing's side of the sign-in (security type 30):
// version 3.889, the types it offers, its key, the credentials it accepts.
type fakeApple struct {
	types    []byte
	gen      uint16
	prime    *big.Int
	user     string
	password string
	gotUser  chan string
	chose    chan byte
}

func (f *fakeApple) serve(c net.Conn) error {
	defer c.Close()
	io.WriteString(c, "RFB 003.889\n")
	var ver [12]byte
	if _, err := io.ReadFull(c, ver[:]); err != nil {
		return err
	}
	if string(ver[:]) != "RFB 003.008\n" {
		return errors.New("client version " + string(ver[:]))
	}
	c.Write(append([]byte{byte(len(f.types))}, f.types...))
	var ch [1]byte
	if _, err := io.ReadFull(c, ch[:]); err != nil {
		return err
	}
	if f.chose != nil {
		f.chose <- ch[0]
	}
	switch ch[0] {
	case SecApple:
	case SecVNCAuth:
		challenge := make([]byte, 16)
		c.Write(challenge)
		io.ReadFull(c, make([]byte, 16))
		binary.Write(c, binary.BigEndian, uint32(1))
		binary.Write(c, binary.BigEndian, uint32(0))
		return errors.New("vnc auth")
	default:
		return errors.New("unexpected type")
	}
	keyLen := (f.prime.BitLen() + 7) / 8
	priv, _ := rand.Int(rand.Reader, f.prime)
	pub := new(big.Int).Exp(big.NewInt(int64(f.gen)), priv, f.prime)
	msg := make([]byte, 4+2*keyLen)
	binary.BigEndian.PutUint16(msg[0:], f.gen)
	binary.BigEndian.PutUint16(msg[2:], uint16(keyLen))
	f.prime.FillBytes(msg[4 : 4+keyLen])
	pub.FillBytes(msg[4+keyLen:])
	c.Write(msg)
	ans := make([]byte, 128+keyLen)
	if _, err := io.ReadFull(c, ans); err != nil {
		return err
	}
	clientPub := new(big.Int).SetBytes(ans[128:])
	shared := new(big.Int).Exp(clientPub, priv, f.prime)
	sb := make([]byte, keyLen)
	shared.FillBytes(sb)
	key := md5.Sum(sb)
	blk, _ := aes.NewCipher(key[:])
	creds := make([]byte, 128)
	for i := 0; i < 128; i += 16 {
		blk.Decrypt(creds[i:i+16], ans[i:i+16])
	}
	cstr := func(b []byte) string {
		if i := bytes.IndexByte(b, 0); i >= 0 {
			return string(b[:i])
		}
		return "<no NUL>"
	}
	user, pw := cstr(creds[:64]), cstr(creds[64:])
	if f.gotUser != nil {
		f.gotUser <- user
	}
	if user != f.user || pw != f.password {
		binary.Write(c, binary.BigEndian, uint32(1))
		reason := "Authentication failed"
		binary.Write(c, binary.BigEndian, uint32(len(reason)))
		io.WriteString(c, reason)
		return errors.New("bad credentials")
	}
	binary.Write(c, binary.BigEndian, uint32(0))
	var shared1 [1]byte
	if _, err := io.ReadFull(c, shared1[:]); err != nil {
		return err
	}
	si := make([]byte, 24)
	binary.BigEndian.PutUint16(si[0:], 1920)
	binary.BigEndian.PutUint16(si[2:], 1080)
	si[4], si[5] = 32, 24
	name := "Mac Studio"
	binary.BigEndian.PutUint32(si[20:], uint32(len(name)))
	c.Write(append(si, name...))
	_, err := io.Copy(c, c)
	return err
}

func startApple(t *testing.T, f *fakeApple) net.Conn {
	t.Helper()
	a, b := net.Pipe()
	go f.serve(b)
	t.Cleanup(func() { a.Close() })
	return a
}

func realPrime(t *testing.T) *big.Int {
	p, ok := new(big.Int).SetString(rfc3526Group16, 16)
	if !ok || p.BitLen() != 4096 {
		t.Fatal("bad test prime")
	}
	return p
}

func TestAppleSignIn(t *testing.T) {
	small, err := rand.Prime(rand.Reader, 128)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		prime *big.Int
		gen   uint16
		user  string
		pw    string
	}{
		{"small prime", small, 2, "alice", "pw"},
		{"real prime", realPrime(t), 5, "alice", "Ünïcode pass wörd!"},
		{"longest credentials", realPrime(t), 5, strings.Repeat("u", 63), strings.Repeat("p", 63)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeApple{types: []byte{SecApple, 33, 36, 35}, gen: tc.gen, prime: tc.prime, user: tc.user, password: tc.pw,
				gotUser: make(chan string, 1)}
			conn := startApple(t, f)
			rw, info, err := ClientHandshake(conn, Options{User: tc.user, Password: tc.pw})
			if err != nil {
				t.Fatal(err)
			}
			if info.Security != "apple" || info.Version != "3.8" || info.Resolution() != "1920x1080" || info.Name != "Mac Studio" {
				t.Fatalf("info %+v", info)
			}
			if u := <-f.gotUser; u != tc.user {
				t.Fatalf("server decrypted user %q", u)
			}
			rw.Write([]byte("ping"))
			buf := make([]byte, 4)
			io.ReadFull(rw, buf)
			if string(buf) != "ping" {
				t.Fatalf("echo %q", buf)
			}
		})
	}
}

func TestAppleSignInRefused(t *testing.T) {
	f := &fakeApple{types: []byte{SecApple}, gen: 5, prime: realPrime(t), user: "alice", password: "right"}
	_, _, err := ClientHandshake(startApple(t, f), Options{User: "alice", Password: "wrong"})
	if !errors.Is(err, ErrAuth) || !strings.Contains(err.Error(), "Authentication failed") {
		t.Fatalf("wrong password: %v", err)
	}
	if strings.Contains(err.Error(), "wrong") {
		t.Fatal("the error must not carry the password")
	}
}

// The account password goes to Apple's sign-in only: with a user, a server
// offering VNC authentication first still gets type 30; without a user the
// client never picks 30.
func TestAppleChoice(t *testing.T) {
	f := &fakeApple{types: []byte{SecVNCAuth, SecApple}, gen: 2, prime: realPrime(t), user: "alice", password: "pw", chose: make(chan byte, 1)}
	if _, _, err := ClientHandshake(startApple(t, f), Options{User: "alice", Password: "pw"}); err != nil {
		t.Fatal(err)
	}
	if c := <-f.chose; c != SecApple {
		t.Fatalf("chose %d", c)
	}

	f = &fakeApple{types: []byte{SecApple}, gen: 2, prime: realPrime(t)}
	_, _, err := ClientHandshake(startApple(t, f), Options{Password: "vnc-password"})
	if err == nil || !strings.Contains(err.Error(), "user name and password") {
		t.Fatalf("no user: %v", err)
	}

	f = &fakeApple{types: []byte{SecApple}, gen: 2, prime: realPrime(t)}
	_, _, err = ClientHandshake(startApple(t, f), Options{User: "alice"})
	if err == nil {
		t.Fatal("a user without a password must not sign in")
	}
}

func TestAppleBadInput(t *testing.T) {
	f := &fakeApple{types: []byte{SecApple}, gen: 2, prime: realPrime(t), user: "alice", password: "pw"}
	if _, _, err := ClientHandshake(startApple(t, f), Options{User: "alice", Password: strings.Repeat("x", 64)}); err == nil {
		t.Fatal("a 64-byte password does not fit")
	}
	f = &fakeApple{types: []byte{SecApple}, gen: 2, prime: realPrime(t), user: "alice", password: "pw"}
	if _, _, err := ClientHandshake(startApple(t, f), Options{User: "al\x00ice", Password: "pw"}); err == nil {
		t.Fatal("a NUL in the user name must be refused")
	}
	// A server key of 1 (a trivial shared secret) is refused.
	a, b := net.Pipe()
	defer a.Close()
	go func() {
		defer b.Close()
		io.WriteString(b, "RFB 003.889\n")
		io.ReadFull(b, make([]byte, 12))
		b.Write([]byte{1, SecApple})
		io.ReadFull(b, make([]byte, 1))
		msg := make([]byte, 4+32)
		binary.BigEndian.PutUint16(msg[0:], 2)
		binary.BigEndian.PutUint16(msg[2:], 16)
		p, _ := rand.Prime(rand.Reader, 128)
		p.FillBytes(msg[4:20])
		msg[35] = 1
		b.Write(msg)
		io.Copy(io.Discard, b)
	}()
	if _, _, err := ClientHandshake(a, Options{User: "alice", Password: "pw"}); err == nil || !strings.Contains(err.Error(), "public key") {
		t.Fatalf("trivial key: %v", err)
	}
}

// With a user, only Apple's sign-in will do: a server that offers None (or
// only VNC authentication or VeNCrypt) is not macOS's Screen Sharing, and
// it must get neither the account nor keys typed afterwards.
func TestAppleOnlyWithUser(t *testing.T) {
	f := &fakeApple{types: []byte{SecNone, SecApple}, gen: 2, prime: realPrime(t), user: "alice", password: "pw", chose: make(chan byte, 1)}
	if _, info, err := ClientHandshake(startApple(t, f), Options{User: "alice", Password: "pw"}); err != nil || info.Security != "apple" {
		t.Fatalf("None offered first: %v %+v", err, info)
	}
	if c := <-f.chose; c != SecApple {
		t.Fatalf("chose %d", c)
	}
	for _, types := range [][]byte{{SecNone}, {SecVNCAuth}, {SecVeNCrypt}, {SecNone, SecVNCAuth, SecVeNCrypt}} {
		a, b := net.Pipe()
		got := make(chan []byte, 1)
		go func() {
			defer b.Close()
			io.WriteString(b, "RFB 003.889\n")
			io.ReadFull(b, make([]byte, 12))
			b.Write(append([]byte{byte(len(types))}, types...))
			rest, _ := io.ReadAll(b)
			got <- rest
		}()
		_, _, err := ClientHandshake(a, Options{User: "alice", Password: "pw"})
		a.Close()
		if !errors.Is(err, ErrNotApple) {
			t.Fatalf("%v: %v", types, err)
		}
		if rest := <-got; len(rest) != 0 {
			t.Fatalf("%v: the client sent %v after the types", types, rest)
		}
	}
	// RFB 3.3: the server picks; anything but 30 is refused.
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		io.WriteString(b, "RFB 003.003\n")
		io.ReadFull(b, make([]byte, 12))
		binary.Write(b, binary.BigEndian, uint32(SecNone))
		io.Copy(io.Discard, b)
	}()
	defer a.Close()
	if _, _, err := ClientHandshake(a, Options{User: "alice", Password: "pw"}); !errors.Is(err, ErrNotApple) {
		t.Fatalf("3.3 None: %v", err)
	}
}

// Greeted runs after the server's version and before the client says
// anything; its error ends the handshake.
func TestGreeted(t *testing.T) {
	a, b := net.Pipe()
	got := make(chan []byte, 1)
	go func() {
		defer b.Close()
		io.WriteString(b, "RFB 003.889\n")
		rest, _ := io.ReadAll(b)
		got <- rest
	}()
	refused := errors.New("not Apple's")
	_, _, err := ClientHandshake(a, Options{User: "alice", Password: "pw", Greeted: func() error { return refused }})
	a.Close()
	if !errors.Is(err, refused) {
		t.Fatalf("err %v", err)
	}
	if rest := <-got; len(rest) != 0 {
		t.Fatalf("the client sent %q before the check", rest)
	}
	called := false
	f := &fakeApple{types: []byte{SecApple}, gen: 2, prime: realPrime(t), user: "alice", password: "pw"}
	if _, _, err := ClientHandshake(startApple(t, f), Options{User: "alice", Password: "pw", Greeted: func() error { called = true; return nil }}); err != nil || !called {
		t.Fatalf("greeted ok: %v %v", err, called)
	}
}
