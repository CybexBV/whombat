package screen

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// verifyAccount checks the account's password with the Mac's directory
// (`dscl .`'s authonly, fed on stdin so the password never shows in the
// process list). It doesn't count as someone using the Mac, unlike a
// Screen Sharing sign-in. known is false when it can't tell: not a Mac, or
// a user name or password dscl's command line can't carry as one word
// (spaces, quotes, backslashes).
func verifyAccount(ctx context.Context, a Account) (ok, known bool) {
	if runtime.GOOS != "darwin" || strings.ContainsAny(a.User+a.Password, " \t\"'\\") {
		return false, false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/dscl", ".")
	cmd.Stdin = strings.NewReader("authonly " + a.User + " " + a.Password + "\n")
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TERM=dumb", "HOME=" + os.TempDir()}
	out, err := cmd.CombinedOutput()
	return authonlyAnswer(out, err)
}

// authonlyAnswer reads dscl's answer: nothing but its banner when the
// password is right, eDSAuthFailed (or another eDSAuth… refusal) when not.
func authonlyAnswer(out []byte, err error) (ok, known bool) {
	switch {
	case bytes.Contains(out, []byte("eDSAuth")):
		return false, true
	case err != nil || bytes.Contains(out, []byte("DS Error")):
		return false, false
	}
	return true, true
}
