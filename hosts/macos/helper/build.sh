#!/bin/bash
# Builds Whombat Helper on a Mac (README.md): the unit tests, a universal release build (Apple silicon and Intel,
# macOS 13 and later), the app bundle, signed with the team's Developer ID (hardened runtime, secure timestamp),
# notarized by Apple and stapled, then zipped into dist/ with its version, sha256 and size, and scanned for texts the
# repository must never hold (the repository's scripts/scan-artifacts.sh).
#
#   macos/helper/build.sh                            everything: dist/whombat-helper-macos.zip and its .json
#   macos/helper/build.sh --unsigned                 tests and the app, signed ad hoc, in build/: to try it here
#   macos/helper/build.sh --adhoc-dist               dist/ signed ad hoc, not notarized: until the team has a Developer ID
#   macos/helper/build.sh --request-certificate      once: a certificate request for developer.apple.com
#   macos/helper/build.sh --import-certificate F     the Developer ID certificate Apple made from it (F, a .cer)
#   … --no-test                                      skip `swift test`
#
# Signing uses the team's Developer ID Application certificate, whose private key lives only in a keychain of its
# own, ~/Library/Keychains/whombat-helper.keychain-db (its random password in ~/.config/whombat/helper/keychain.pass).
# Only the team's Account Holder can make that certificate: Apple refuses an API key, both through the App Store
# Connect API and for Xcode's cloud signing. So --request-certificate makes the key and a request once, the Account
# Holder turns the request into the certificate on developer.apple.com, and --import-certificate puts it next to its
# key. The keychain is unlocked for the build and handed to codesign directly; it is never put in the user's keychain
# search list, where Xcode would pick it for other builds in other sessions and fail on it while it is locked.
# Notarization uses the team's App Store Connect API key: asc.json ({"keyId", "issuerId"}) and AuthKey_<keyId>.p8 in
# ~/.config/whombat/ios, or in $WHOMBAT_ASC_DIR. Portable to macOS's bash 3.2.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
self=$here/$(basename "$0")
root=$(cd "$here/../.." && pwd)
cd "$here"

TEAM=4R8P9MTF9T
BUNDLE_ID=com.whombat.helper
APP_NAME="Whombat Helper"
EXECUTABLE=WhombatHelper
MIN_MACOS=13.0
# macOS's own LibreSSL: Homebrew's OpenSSL 3 and later make .p12 files `security import` can't read.
OPENSSL=/usr/bin/openssl

asc_dir=${WHOMBAT_ASC_DIR:-$HOME/.config/whombat/ios}
signing_dir=$HOME/.config/whombat/helper
pending=$signing_dir/pending
request_file=whombat-helper.certSigningRequest
keychain=$HOME/Library/Keychains/whombat-helper.keychain-db
out=$here/build
app=$out/$APP_NAME.app
zip=$here/dist/whombat-helper-macos.zip
manifest=$here/dist/whombat-helper-macos.json

say() { printf '==> %s\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }
# A copy of a private key sits in a work folder while it goes into the keychain; it goes however the script ends.
work=""
trap 'if [ -n "$work" ]; then rm -rf "$work"; fi' EXIT

mode=release
run_tests=1
certificate=""
while [ $# -gt 0 ]; do
  case $1 in
    --unsigned) mode=unsigned ;;
    --adhoc-dist) mode=adhoc ;;
    --request-certificate) mode=request ;;
    --import-certificate)
      mode=import
      certificate=${2:-}
      [ -n "$certificate" ] || die "--import-certificate needs the .cer file Apple made"
      shift
      ;;
    --no-test) run_tests=0 ;;
    -h | --help) sed -n '2,24p' "$self" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || die "this builds on a Mac (Xcode's swift, codesign, notarytool)"
case $keychain$signing_dir in *" "*) die "the keychain's path can't have a space in it: $keychain" ;; esac
version=$(tr -d ' \n' < VERSION)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must be X.Y.Z, not '$version'"

# Runs security(1) commands that carry the keychain's password, reading them from standard input so the password is
# never on a command line (where `ps` shows it).
secure() { printf '%s\n' "$1" | security -i >/dev/null; }

asc_value() { plutil -extract "$1" raw -o - "$asc_dir/asc.json"; }

unlock() {
  secure "unlock-keychain -p $(cat "$signing_dir/keychain.pass") $keychain"
  # Locks itself again after two idle hours and when the Mac sleeps.
  security set-keychain-settings -lut 7200 "$keychain"
}

# The helper's keychain, made the first time with a random password kept in the signing folder.
ensure_keychain() {
  local pass
  mkdir -p "$signing_dir"
  chmod 700 "$signing_dir"
  if [ ! -f "$keychain" ]; then
    pass=$("$OPENSSL" rand -hex 24)
    (umask 077 && printf '%s\n' "$pass" > "$signing_dir/keychain.pass")
    secure "create-keychain -p $pass $keychain"
    say "made the keychain $keychain"
  fi
  [ -f "$signing_dir/keychain.pass" ] ||
    die "$keychain is there but its password file isn't: move the keychain away (it may hold the only copy of a Developer ID key) and run again"
  unlock
}

# The SHA-1 of a Developer ID Application identity in the keychain that is valid for 30 more days, or nothing.
current_identity() {
  [ -f "$keychain" ] || return 0
  local sha pem
  for sha in $(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application: / { print $2 }'); do
    # awk reads to the end: stopping early would end `security` with SIGPIPE, which pipefail counts as a failure.
    pem=$(security find-certificate -a -Z -p "$keychain" | awk -v want="$sha" '
      /^SHA-1 hash:/ { on = ($3 == want) }
      on && !done && /BEGIN CERTIFICATE/ { p = 1 }
      p { print }
      p && /END CERTIFICATE/ { p = 0; done = 1 }')
    if [ -n "$pem" ] && printf '%s\n' "$pem" | "$OPENSSL" x509 -noout -checkend $((30 * 86400)) >/dev/null; then
      echo "$sha"
      return 0
    fi
  done
}

# A private key and a request for a certificate of it, kept until the certificate comes back. Run again, it shows the
# same request: Apple may already have made a certificate from it.
request_certificate() {
  ensure_keychain
  mkdir -p "$pending"
  chmod 700 "$pending"
  if [ ! -f "$pending/key.pem" ]; then
    (umask 077 && "$OPENSSL" genrsa -out "$pending/key.pem" 2048 2>/dev/null)
    "$OPENSSL" req -new -key "$pending/key.pem" -out "$pending/$request_file" -subj "/CN=$APP_NAME"
  fi
  cat <<TEXT
The certificate request is $pending/$request_file
The team's Account Holder turns it into the certificate, once:
  1. developer.apple.com → Account → Certificates, IDs & Profiles → Certificates → +
  2. Developer ID Application, profile type G2 Sub-CA → Continue
  3. Choose the request file above → Continue → Download (developerID_application.cer)
  4. On this Mac: $self --import-certificate <the downloaded .cer>
TEXT
}

# Puts the certificate Apple made from the pending request into the helper's keychain with its key. An identity
# that runs out stays there: a Developer ID certificate is never revoked here, since that would stop the helpers
# already installed with it.
import_certificate() {
  local file=$1 subject rc sha1
  [ -f "$file" ] || die "no file $file"
  [ -f "$pending/key.pem" ] || die "no key waiting for a certificate: run --request-certificate first"
  ensure_keychain
  work=$(mktemp -d "$signing_dir/import.XXXXXX")
  # Apple's download is DER; a PEM copy is fine too.
  "$OPENSSL" x509 -inform DER -in "$file" -out "$work/cert.pem" 2>/dev/null ||
    "$OPENSSL" x509 -in "$file" -out "$work/cert.pem" 2>/dev/null || die "$file isn't a certificate"
  subject=$("$OPENSSL" x509 -in "$work/cert.pem" -noout -subject)
  case $subject in
    *"Developer ID Application: "*"($TEAM)"*) ;;
    *) die "$file isn't the team's Developer ID Application certificate ($subject)" ;;
  esac
  [ "$("$OPENSSL" x509 -in "$work/cert.pem" -noout -modulus)" = "$("$OPENSSL" rsa -in "$pending/key.pem" -noout -modulus 2>/dev/null)" ] ||
    die "$file was made from another request than $pending/$request_file"
  # In a subshell of its own, outside any `if`, so `set -e` stops it at the first failure.
  set +e
  (
    set -e
    p12pass=$("$OPENSSL" rand -hex 12)
    "$OPENSSL" pkcs12 -export -inkey "$pending/key.pem" -in "$work/cert.pem" -out "$work/id.p12" \
      -name "$APP_NAME Developer ID" -passout "pass:$p12pass"
    security import "$work/id.p12" -k "$keychain" -P "$p12pass" -T /usr/bin/codesign >/dev/null
    # Lets codesign use the key without anyone clicking “Allow” on the Mac's screen.
    secure "set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $(cat "$signing_dir/keychain.pass") $keychain"
    sha1=$("$OPENSSL" x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
    if ! security find-identity -v -p codesigning "$keychain" | grep -q "$sha1"; then
      # The chain needs Apple's Developer ID intermediate, which macOS doesn't always have (the G2 one).
      case $("$OPENSSL" x509 -in "$work/cert.pem" -noout -issuer) in
        *G2*) ca=DeveloperIDG2CA.cer ;;
        *) ca=DeveloperIDCA.cer ;;
      esac
      curl -fsSL -o "$work/ca.cer" "https://www.apple.com/certificateauthority/$ca"
      security import "$work/ca.cer" -k "$keychain" >/dev/null
      if ! security find-identity -v -p codesigning "$keychain" | grep -q "$sha1"; then
        echo "the identity isn't valid for code signing (its chain doesn't reach Apple's root):" >&2
        security find-identity -p codesigning "$keychain" >&2
        exit 1
      fi
    fi
    printf '{"sha1": "%s", "notAfter": "%s"}\n' "$sha1" \
      "$("$OPENSSL" x509 -in "$work/cert.pem" -noout -enddate | sed 's/^notAfter=//')" > "$signing_dir/identity.json"
  )
  rc=$?
  set -e
  rm -rf "$work"
  work=""
  [ "$rc" = 0 ] || die "the certificate couldn't be stored in $keychain"
  # The key is in the keychain now, its only copy.
  rm -rf "$pending"
  sha1=$(plutil -extract sha1 raw -o - "$signing_dir/identity.json")
  say "the Developer ID identity $sha1 is in $keychain (until $(plutil -extract notAfter raw -o - "$signing_dir/identity.json"))"
}

identity() {
  identity_sha=$(current_identity)
  if [ -z "$identity_sha" ] || [ ! -f "$signing_dir/keychain.pass" ]; then
    die "no Developer ID identity valid for 30 more days in $keychain: run $self --request-certificate (README.md, Signing)"
  fi
  unlock
}

case $mode in
  request) request_certificate; exit 0 ;;
  import) import_certificate "$certificate"; exit 0 ;;
  # Before the build: without an identity there is nothing to make.
  release) identity ;;
esac

# 1. Tests and the build.
mkdir -p "$out"
if [ "$run_tests" = 1 ]; then
  say "swift test"
  if ! swift test --scratch-path "$out/spm-test" > "$out/test.log" 2>&1; then
    grep -E "error|failed" "$out/test.log" | tail -40 >&2
    die "the unit tests failed (whole log: $out/test.log)"
  fi
  grep -E "Executed [0-9]+ tests" "$out/test.log" | tail -1
fi
say "building $APP_NAME $version for arm64 and x86_64"
build=(swift build -c release --arch arm64 --arch x86_64 --scratch-path "$out/spm")
if ! "${build[@]}" > "$out/build.log" 2>&1; then
  grep -E "error" "$out/build.log" | tail -40 >&2
  die "the build failed (whole log: $out/build.log)"
fi
binary="$("${build[@]}" --show-bin-path)/$EXECUTABLE"
[ -f "$binary" ] || die "no $binary after the build"

# 2. The app bundle.
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/$EXECUTABLE"
# Local symbols and the debug map (which names the build folder) go; the signature covers what is left.
xcrun strip -S -x "$app/Contents/MacOS/$EXECUTABLE"
printf 'APPL????' > "$app/Contents/PkgInfo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleDisplayName</key><string>$APP_NAME</string>
	<key>CFBundleExecutable</key><string>$EXECUTABLE</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>$APP_NAME</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$version</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
	<key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
	<key>LSUIElement</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null
archs=$(lipo -archs "$app/Contents/MacOS/$EXECUTABLE")
for arch in arm64 x86_64; do
  case " $archs " in *" $arch "*) ;; *) die "the binary is $archs, not universal" ;; esac
done
for arch in arm64 x86_64; do
  minos=$(otool -arch "$arch" -l "$app/Contents/MacOS/$EXECUTABLE" | awk '/LC_BUILD_VERSION/ { b = 1 } b && $1 == "minos" { print $2; exit }')
  [ "$minos" = "$MIN_MACOS" ] || die "the $arch binary needs macOS $minos, not $MIN_MACOS"
done
if strings -a "$app/Contents/MacOS/$EXECUTABLE" | grep -F "$HOME" >/dev/null; then die "the binary names this Mac's home folder"; fi
# Finder information or other extended attributes would make codesign refuse the bundle.
xattr -cr "$app"

if [ "$mode" = unsigned ]; then
  codesign --force --sign - --options runtime "$app"
  say "built $app (signed ad hoc: for this Mac only)"
  exit 0
fi

if [ "$mode" = adhoc ]; then
  # Until the team has a Developer ID: the zip is signed ad hoc and not notarized. Macs run it (installed with curl,
  # it has no quarantine), but its Accessibility permission doesn't survive the next helper version.
  codesign --force --sign - --options runtime "$app"
  codesign --verify --strict --deep "$app"
else

# 3. Sign with the Developer ID: hardened runtime (notarization needs it), a secure timestamp, no entitlements.
# The keychain may have locked itself during a long build.
unlock
say "signing with $identity_sha"
codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity_sha" "$app"
codesign --verify --strict --deep --verbose=2 "$app"
signed=$(codesign -dvvv "$app" 2>&1)
grep -q "^Authority=Developer ID Application: .*($TEAM)" <<<"$signed" || die "not signed by the team's Developer ID"
grep -q '^Timestamp=' <<<"$signed" || die "the signature has no secure timestamp"
grep -q 'flags=0x10000(runtime)' <<<"$signed" || die "the signature has no hardened runtime"

# 4. Notarize with the API key, then staple the ticket to the app so it opens without asking Apple first.
say "notarizing (usually a few minutes)"
key_id=$(asc_value keyId)
notary=(--key "$asc_dir/AuthKey_$key_id.p8" --key-id "$key_id" --issuer "$(asc_value issuerId)")
rm -f "$out/notarize.zip"
ditto -c -k --keepParent "$app" "$out/notarize.zip"
xcrun notarytool submit "$out/notarize.zip" "${notary[@]}" --wait --timeout 1h --output-format json \
  > "$out/notary.json" || true
status=$(plutil -extract status raw -o - "$out/notary.json" 2>/dev/null || echo "no answer")
submission=$(plutil -extract id raw -o - "$out/notary.json" 2>/dev/null || true)
if [ "$status" != Accepted ]; then
  [ -z "$submission" ] || xcrun notarytool log "$submission" "${notary[@]}" "$out/notary-log.json" || true
  [ -f "$out/notary-log.json" ] && cat "$out/notary-log.json" >&2
  die "notarization: $status (submission ${submission:-none})"
fi
say "notarized: submission $submission accepted"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app" > "$out/spctl.txt" 2>&1 || true
cat "$out/spctl.txt"
grep -q 'source=Notarized Developer ID' "$out/spctl.txt" || die "Gatekeeper doesn't accept it as notarized"

fi

# 5. The zip the hosts service serves and install.sh unpacks with `ditto -x -k`, and its manifest.
mkdir -p "$(dirname "$zip")"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
check=$(mktemp -d "$out/check.XXXXXX")
ditto -x -k "$zip" "$check"
codesign --verify --strict --deep "$check/$APP_NAME.app"
[ "$mode" = adhoc ] || xcrun stapler validate "$check/$APP_NAME.app" >/dev/null
[ "$("$check/$APP_NAME.app/Contents/MacOS/$EXECUTABLE" --version)" = "$version" ] || die "the zipped app doesn't say $version"
rm -rf "$check"
sha=$(shasum -a 256 "$zip" | cut -d' ' -f1)
size=$(stat -f %z "$zip")
# The team lets an agent take this build where the installed helper isn't the team's yet (none, or signed ad hoc).
team=$TEAM
[ "$mode" != adhoc ] || team=""
printf '{"version": "%s", "sha256": "%s", "size": %s, "team": "%s"}\n' "$version" "$sha" "$size" "$team" > "$manifest"

# 6. Nothing the repository must never hold (the maintainers' guard list; WHOMBAT_GUARDS_REQUIRED=1 to insist).
bash "$root/../scripts/scan-artifacts.sh" "$zip"
say "dist/whombat-helper-macos.zip: $version, $size bytes, sha256 $sha"
