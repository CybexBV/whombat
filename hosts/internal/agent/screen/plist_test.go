package screen

import (
	"context"
	"testing"
)

// ioregLocked is `ioreg -n Root -d1 -a` of a Mac whose screen is locked
// (macOS 27.2.1; names and ids made up).
const ioregLocked = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>IOConsoleLocked</key>
	<false/>
	<key>IOConsoleUsers</key>
	<array>
		<dict>
			<key>CGSSessionScreenIsLocked</key>
			<true/>
			<key>CGSSessionScreenLockedTime</key>
			<integer>1794904679</integer>
			<key>kCGSSessionOnConsoleKey</key>
			<true/>
			<key>kCGSSessionSecureInputPID</key>
			<integer>619</integer>
			<key>kCGSSessionUserIDKey</key>
			<integer>501</integer>
			<key>kCGSSessionUserNameKey</key>
			<string>alex</string>
			<key>kCGSessionLoginDoneKey</key>
			<true/>
			<key>kCGSessionLongUserNameKey</key>
			<string>Alex Example</string>
		</dict>
		<dict>
			<key>kCGSSessionOnConsoleKey</key>
			<false/>
			<key>kCGSSessionUserIDKey</key>
			<integer>502</integer>
			<key>kCGSSessionUserNameKey</key>
			<string>sam</string>
			<key>kCGSessionLoginDoneKey</key>
			<true/>
		</dict>
	</array>
	<key>IORegistryEntryName</key>
	<string>Root</string>
	<key>IOKitBuildVersion</key>
	<string>Darwin Kernel Version 27.2.0</string>
	<key>IOResourceMatch</key>
	<data>AAEC</data>
	<key>IOSomeReal</key>
	<real>1.5</real>
</dict>
</plist>`

func TestConsoleSessions(t *testing.T) {
	s, err := parseConsoleSessions([]byte(ioregLocked))
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 2 || s[0].User != "alex" || s[0].UID != 501 || !s[0].OnConsole || !s[0].Locked || !s[0].LoggedIn || s[1].OnConsole || s[1].Locked {
		t.Fatalf("%+v", s)
	}
	if s[0].SecureInputPID != 619 || s[1].SecureInputPID != 0 || secureInputPID(s) != 619 || secureInputPID(s[1:]) != 0 {
		t.Fatalf("secure input: %+v", s)
	}
	if locked, _ := lockState(s); !locked {
		t.Fatal("locked")
	}
	s[0].Locked = false
	if locked, _ := lockState(s); locked {
		t.Fatal("unlocked")
	}
	if locked, _ := lockState(nil); !locked {
		t.Fatal("the login window waits for a password")
	}
	if _, err := parseConsoleSessions([]byte("not a plist")); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestBundleVersion(t *testing.T) {
	plist := `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.whombat.helper</string>
<key>CFBundleShortVersionString</key><string> 1.4.2 </string><key>LSUIElement</key><true/></dict></plist>`
	if v := bundleVersion([]byte(plist)); v != "1.4.2" {
		t.Fatalf("%q", v)
	}
	if v := bundleVersion([]byte("bplist00\x01")); v != "" {
		t.Fatalf("binary plist: %q", v)
	}
}

func TestAuthonlyAnswer(t *testing.T) {
	banner := "No entry for terminal type \"unknown\";\nusing dumb terminal settings.\n"
	if ok, known := authonlyAnswer([]byte(banner+"Goodbye\n"), nil); !ok || !known {
		t.Fatal("right password")
	}
	failed := banner + "<dscl_cmd> DS Error: -14090 (eDSAuthFailed)\nAuthentication for node /Local/Default failed. (-14090, eDSAuthFailed)\nGoodbye\n"
	if ok, known := authonlyAnswer([]byte(failed), nil); ok || !known {
		t.Fatal("wrong password")
	}
	if _, known := authonlyAnswer([]byte("<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n"), nil); known {
		t.Fatal("another error can't tell")
	}
	if ok, known := verifyAccount(context.Background(), Account{User: "alice", Password: "two words"}); ok || known {
		t.Fatal("a password with a space isn't checked")
	}
}
