# The graphical kiosk on tty1 (CG-01, CG-03, CG-04; NX-78, NX-82): cage (wlroots, pixman software renderer) runs
# Chromium in kiosk mode as the user whombat-kiosk and shows one local page, the web app a local server serves
# (whombat-console --serve on the appliance, whombat-installer-ui on the installer ISO). Used by the appliance
# (console.nix) and the installer ISO (installer-base.nix), which set the server, its port and its token directory.
#
# - Seat: a logind session on seat0 / VT 1 through PAM (pam_systemd, class user-light: no per-user service manager),
#   as nixpkgs' services.cage does; cage opens the DRM and input devices through logind (libseat), so the unit
#   itself opens no device node but its tty.
# - The token: the server writes `<tokenDir>/token` (0640) at every start; tokenDir is 2750 <server user>:whombat-kiosk,
#   so the kiosk reads it and nobody else but root does. The launcher puts it in the URL fragment (#t=…); the page
#   sends it as a Bearer token. A server restart makes a new token, so the server restarts a running kiosk.
# - Network: `joinServerNetwork` puts the kiosk into the server's private network namespace (appliance: the two
#   share a loopback nothing else on the box sees, and the kiosk reaches no network at all); otherwise the host's.
#   udevd's messages stay in the host's namespace, so whombat-kiosk-udev passes the input devices' into the server's:
#   a keyboard or mouse plugged in later (a Bluetooth one at every connection) works without a restart (NX-400).
# - Chromium: enterprise policies allow only the server's origin and turn off everything a kiosk doesn't need; the page
#   as an app window with a fresh profile on tmpfs (RuntimeDirectory) at every start (not incognito, CG-28), reduced
#   motion, no GPU (software compositing).
# - Fallback (CG-05): no DRM device within `drmWaitSec`, or three failures in a row, and the unit fails for good;
#   `fallbackUnit` (the text console) takes tty1 through OnFailure=. Restarts from outside (the server's new token, a
#   display plugged in) reset the count.
# - The desk display (Whombat DK-08, DK-09, DK-11; NX-161…NX-164, NX-169): `gpu` (off by default, NX-169) draws with the
#   graphics chip where a real one is bound (VMs keep software rendering); `desk` lets the page use the microphone and play
#   sound, and the loop follows the desk's state (a paired screen never sleeps in the day; quiet hours dim the
#   backlight or turn it off); `transform` turns a portrait panel to landscape.
# - Sound with `desk` (HD-04, NX-255): the sound server (sound.nix, system-wide PipeWire); Chromium plays and records
#   through its PulseAudio socket (`PULSE_SERVER`), the kiosk's user in its group.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.kiosk;
  inherit (lib) mkOption types;
  origin = "http://127.0.0.1:${toString cfg.port}";
  tokenFile = "${cfg.tokenDir}/token";

  # Chromium enterprise policies (chrome://policy names). Only the page's origin; nothing that saves, prints,
  # downloads, signs in, installs, translates, reports or opens another tool.
  policies = {
    # `*` leaves Chromium's own pages (chrome://newtab, chrome://policy, …) open: those schemes are named too.
    URLBlocklist = [
      "*"
      "chrome://*"
      "chrome-untrusted://*"
      "chrome-extension://*"
      "chrome-search://*"
      "devtools://*"
      "view-source:*"
      "file://*"
      "javascript://*"
    ];
    URLAllowlist = [ origin ];
    DeveloperToolsAvailability = 2;
    DownloadRestrictions = 3;
    AllowFileSelectionDialogs = false;
    PrintingEnabled = false;
    PasswordManagerEnabled = false;
    AutofillAddressEnabled = false;
    AutofillCreditCardEnabled = false;
    ExtensionInstallBlocklist = [ "*" ];
    TranslateEnabled = false;
    SyncDisabled = true;
    BrowserSignin = 0;
    BrowserAddPersonEnabled = false;
    BrowserGuestModeEnabled = false;
    # Not incognito (CG-18): Chromium doesn't put an incognito window into kiosk mode (tabs and the address bar
    # stay). The profile is new at every start instead, on tmpfs, which keeps nothing either.
    IncognitoModeAvailability = 1;
    DefaultBrowserSettingEnabled = false;
    MetricsReportingEnabled = false;
    SearchSuggestEnabled = false;
    SpellcheckEnabled = false;
    SafeBrowsingProtectionLevel = 0;
    ComponentUpdatesEnabled = false;
    BackgroundModeEnabled = false;
    # Off unless `gpu`; with it, `--disable-gpu` still keeps a VM's kiosk in software (NX-161).
    HardwareAccelerationModeEnabled = cfg.gpu;
    # The microphone only for the page's own origin, and only with `desk` (below): never a prompt (NX-163).
    AudioCaptureAllowed = false;
    VideoCaptureAllowed = false;
    ScreenCaptureAllowed = false;
    AutoplayAllowed = false;
    DefaultNotificationsSetting = 2;
    DefaultGeolocationSetting = 2;
    DefaultPopupsSetting = 2;
    DefaultClipboardSetting = 2;
    DefaultSerialGuardSetting = 2;
    DefaultWebUsbGuardSetting = 2;
    DefaultWebHidGuardSetting = 2;
    DefaultWebBluetoothGuardSetting = 2;
    DefaultFileSystemReadGuardSetting = 2;
    DefaultFileSystemWriteGuardSetting = 2;
    PromptForDownloadLocation = false;
    TaskManagerEndProcessEnabled = false;
    EditBookmarksEnabled = false;
    BookmarkBarEnabled = false;
    ShowHomeButton = false;
    ImportBookmarks = false;
    ImportHistory = false;
    ImportSavedPasswords = false;
    NetworkPredictionOptions = 2;
    ShoppingListEnabled = false;
    GenAiDefaultSettings = 2;
    LensOverlaySettings = 1;
  }
  # The desk (NX-163): the page records while a person holds to talk (getUserMedia, without a prompt nobody could
  # answer) and plays the spoken answer and the soft sound of a new ask without a preceding touch.
  // lib.optionalAttrs cfg.desk {
    AudioCaptureAllowedUrls = [ origin ];
    AutoplayAllowlist = [ origin ];
  };

  chromiumFlags = [
    "--kiosk"
    "--no-first-run"
    "--no-default-browser-check"
    "--ozone-platform=wayland"
    "--force-device-scale-factor=1"
    "--noerrdialogs"
    "--disable-infobars"
    "--disable-session-crashed-bubble"
    "--disable-background-networking"
    "--disable-component-update"
    "--disable-default-apps"
    "--disable-extensions"
    "--disable-sync"
    "--disable-breakpad"
    "--disable-client-side-phishing-detection"
    "--disable-pinch"
    "--overscroll-history-navigation=0"
    "--no-pings"
    "--password-store=basic"
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater"
  ]
  # The desk (NX-163): the new-ask chime and a spoken answer play after a kiosk restart before anyone touched the
  # screen (WebAudio too, beside the policy's AutoplayAllowlist); the kiosk shows its one origin only.
  ++ lib.optional cfg.desk "--autoplay-policy=no-user-gesture-required";

  # Without a real graphics chip (VMs, a firmware framebuffer, the installer: NX-161). The avatars' idle motion costs a
  # whole core with software rendering (NX-82, measured in a VM: ~97 % of one core on the claim screen); under reduced
  # motion they stand still, as on the claimed screen (~4 %). The launcher says which (WHOMBAT_KIOSK_RENDER).
  softwareFlags = [
    "--disable-gpu"
    "--force-prefers-reduced-motion"
  ];
  # The loops' Chromium command (bash): software flags unless the launcher found a real graphics chip.
  chromiumCommand = ''
    sw=()
    [ "''${WHOMBAT_KIOSK_RENDER:-software}" = gpu ] || sw=(${lib.escapeShellArgs softwareFlags})
  '';

  # No pointer of its own on the box's screen (CG-410): cage puts one in the middle when it starts (on the Link code's
  # dash) and a VM's tablet or a resting mouse leaves it there. cage and Chromium both draw theirs from this theme, whose
  # every cursor is one transparent pixel, so the only pointer anyone sees is the page's own picture, which it shows
  # while a mouse really moves (console/ui lib/pointer.ts). Every name cage and Chromium ask for (CSS's names, the
  # cursor-shape protocol's and the old X ones) links to the same file; the theme is "default" (what cage and
  # libwayland-cursor ask for) and "Adwaita" (what GTK names when nothing else does).
  # Xcursor files are little-endian: the file header ("Xcur", 16, version 1.0, one entry), the table of contents
  # (image, nominal size 24, its offset) and the image (header 36, image, 24, version 1, 1 x 1, hotspot 0 0, delay 0,
  # one ARGB pixel 0).
  noPointerNames = [
    "default"
    "context-menu"
    "help"
    "pointer"
    "progress"
    "wait"
    "cell"
    "crosshair"
    "text"
    "vertical-text"
    "alias"
    "copy"
    "move"
    "no-drop"
    "not-allowed"
    "grab"
    "grabbing"
    "all-scroll"
    "col-resize"
    "row-resize"
    "n-resize"
    "e-resize"
    "s-resize"
    "w-resize"
    "ne-resize"
    "nw-resize"
    "se-resize"
    "sw-resize"
    "ew-resize"
    "ns-resize"
    "nesw-resize"
    "nwse-resize"
    "zoom-in"
    "zoom-out"
    "dnd-ask"
    "all-resize"
    "arrow"
    "top_left_arrow"
    "question_arrow"
    "whats_this"
    "hand"
    "hand1"
    "hand2"
    "left_ptr_watch"
    "half-busy"
    "watch"
    "plus"
    "cross"
    "tcross"
    "xterm"
    "ibeam"
    "dnd-link"
    "link"
    "dnd-copy"
    "dnd-move"
    "fleur"
    "dnd-no-drop"
    "dnd-none"
    "crossed_circle"
    "forbidden"
    "pirate"
    "X_cursor"
    "openhand"
    "closedhand"
    "sb_h_double_arrow"
    "h_double_arrow"
    "size_hor"
    "split_h"
    "sb_v_double_arrow"
    "v_double_arrow"
    "size_ver"
    "split_v"
    "top_side"
    "bottom_side"
    "right_side"
    "left_side"
    "top_right_corner"
    "top_left_corner"
    "bottom_right_corner"
    "bottom_left_corner"
    "size_bdiag"
    "size_fdiag"
    "fd_double_arrow"
    "bd_double_arrow"
    "sb_up_arrow"
    "sb_down_arrow"
    "sb_left_arrow"
    "sb_right_arrow"
    "center_ptr"
    "color-picker"
    "pencil"
    "right_ptr"
    "draft"
    "up-arrow"
    "down-arrow"
    "left-arrow"
    "right-arrow"
  ];
  noPointer = pkgs.runCommand "whombat-no-pointer" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    mkdir -p $out/share/icons/default/cursors
    python3 -c '
    import struct, sys
    image = struct.pack("<9I", 36, 0xFFFD0002, 24, 1, 1, 1, 0, 0, 0) + struct.pack("<I", 0)
    head = struct.pack("<4s3I", b"Xcur", 16, 0x10000, 1) + struct.pack("<3I", 0xFFFD0002, 24, 28)
    open(sys.argv[1], "wb").write(head + image)
    ' $out/share/icons/default/cursors/left_ptr
    for name in ${lib.escapeShellArgs noPointerNames}; do
      ln -s left_ptr "$out/share/icons/default/cursors/$name"
    done
    printf "[Icon Theme]\nName=default\n" > $out/share/icons/default/index.theme
    ln -s default $out/share/icons/Adwaita
  '';

  # The drivers of a real graphics chip (NX-161): with one bound, cage renders with GLES2 (or Vulkan) and Chromium
  # with the GPU; otherwise (bochs, virtio_gpu, qxl, simpledrm, …) both draw in software as before.
  gpuDrivers = [
    "amdgpu"
    "i915"
    "xe"
    "nouveau"
    "radeon"
  ];

  # A portrait panel turned to landscape (NX-164, `transform`), through cage's wlr-output-management, before Chromium
  # opens its window. `auto`: each enabled output whose current mode is taller than wide and not yet turned gets 90°.
  outputSetup = pkgs.writeShellApplication {
    name = "whombat-kiosk-output";
    runtimeInputs = [
      cfg.wlrRandrPackage
      pkgs.jq
    ];
    bashOptions = [ "nounset" ];
    text = ''
      outputs=$(wlr-randr --json 2>/dev/null) || exit 0
      ${
        if cfg.transform == "auto" then
          ''
            t=90
            names=$(jq -r '.[] | select(.enabled and .transform == "normal")
              | select(([.modes[] | select(.current)] | first) as $m | $m != null and $m.height > $m.width) | .name' <<<"$outputs")
          ''
        else
          ''
            t=${cfg.transform}
            names=$(jq -r '.[] | select(.enabled and .transform != "${cfg.transform}") | .name' <<<"$outputs")
          ''
      }
      while read -r o; do
        [ -n "$o" ] || continue
        if wlr-randr --output "$o" --transform "$t"; then
          echo "whombat-kiosk: the display $o is turned ($t)" >&2
        fi
      done <<<"$names"
    '';
  };
  setupOutputs = lib.optionalString (cfg.transform != "normal") "${outputSetup}/bin/whombat-kiosk-output || true";

  # Every output the page shows on: cage stretches the one window over all of them (its default `-m extend`),
  # and the page draws one screen per output's rectangle. It learns them from the URL's fragment (`&o=`, base64url of
  # `[{n, m, x, y, w, h, mw, mh}]`: the compositor's name, the monitor's model, its place and size in the layout, turned
  # and scaled as it shows, and its size in mm), read here once the outputs are lit and turned. A display plugged in or
  # out restarts the kiosk (NX-147), so the fragment is always the outputs there are. Nothing when wlr-randr can't say:
  # the page is then the whole window, as before.
  outputsParam = pkgs.writeShellApplication {
    name = "whombat-kiosk-outputs";
    runtimeInputs = [
      cfg.wlrRandrPackage
      pkgs.jq
      pkgs.coreutils
    ];
    bashOptions = [ "nounset" ];
    text = ''
      for _ in 1 2 3 4; do
        if json=$(wlr-randr --json 2>/dev/null) &&
          o=$(jq -ce '[.[] | select(.enabled)
            | ((.modes // []) | map(select(.current)) | first) as $m
            | select($m != null)
            | ((.transform // "normal") | test("90|270")) as $turned
            | (.scale // 1) as $s
            | {n: .name,
               m: ((.model // "") | if . == "" or . == "Unknown" then null else . end),
               x: (.position.x // 0),
               y: (.position.y // 0),
               w: ((if $turned then $m.height else $m.width end) / $s | round),
               h: ((if $turned then $m.width else $m.height end) / $s | round),
               mw: ((if $turned then .physical_size.height else .physical_size.width end) // 0),
               mh: ((if $turned then .physical_size.width else .physical_size.height end) // 0)}]
            | select(length > 0)' <<<"$json"); then
          printf '%s' "$o" | base64 -w0 | tr '+/' '-_' | tr -d '=\n'
          exit 0
        fi
        sleep 0.5
      done
    '';
  };
  # The loops' outputs (bash): after the outputs were turned, into the URL's fragment beside the token.
  outputsCommand = ''
    o=$(${outputsParam}/bin/whombat-kiosk-outputs) && [ -n "$o" ] && url="$url&o=$o"
  '';

  # Chromium in a loop inside cage: a window closed from the keyboard (Ctrl+W, Alt+F4) opens the page again with a
  # fresh profile; a crash (non-zero exit) ends cage and counts as a failed start.
  # A switch to another VT (Ctrl+Alt+F2 for the installer's shell) takes the display from cage, and Chromium may crash
  # then: while tty1 isn't the active VT that is no failure, Chromium starts again once tty1 is back (NX-88).
  browser =
    if cfg.sleepAfterSec == null then plainBrowser else "${sleepingBrowser}/bin/whombat-kiosk-browser";
  plainBrowser = pkgs.writeShellScript "whombat-kiosk-browser" ''
    profile=$1 url=$2
    ${setupOutputs}
    ${outputsCommand}
    ${chromiumCommand}
    while :; do
      rm -rf "$profile"
      mkdir -m 0700 "$profile"
      rc=0
      ${cfg.chromiumPackage}/bin/chromium ${lib.escapeShellArgs chromiumFlags} "''${sw[@]}" --user-data-dir="$profile" --app="$url" || rc=$?
      [ "$rc" = 0 ] && continue
      [ "$(${vtActive})" = tty1 ] && exit "$rc"
      until [ "$(${vtActive})" = tty1 ]; do sleep 1; done
    done
  '';

  # The same loop, and the console sleeps (NX-147, `sleepAfterSec`): once nobody has used the console for
  # sleepAfterSec and the box has been claimed for claimedTicks polls in a row (the celebration and the claimed screen
  # show first), Chromium stops and cage, still running, shows nothing (a black screen) until the next key press,
  # pointer movement, button, scroll or touch, which starts Chromium again within seconds. Idle input is cage's own:
  # swayidle on cage's ext-idle-notify-v1 signals the loop (USR1 idle for idleStep, USR2 used again), and the loop
  # counts how long from there. Never while the box isn't claimed: the state comes from the console server's API (the
  # page's own token; the kiosk can't read the console file), polled every 10 s, and a box that stops being claimed
  # while the console sleeps shows it again. No answer from the API: no sleep (and a sleeping console stays asleep: the
  # server's restart restarts the kiosk anyway).
  #
  # The desk display (`desk`, NX-162): when the API's `desk` says the screen is paired, the desk decides. In the day it
  # never sleeps (DK-08). In quiet hours (DK-09) the backlight goes down to `brightness.night`; with “Black” the console
  # sleeps blackAfterSec after the last input with the backlight off, and a touch shows it again for that long. Leaving
  # the night the backlight goes back to its level before (`brightness.day` when the loop doesn't know it). The
  # backlight is set through logind (SetBrightness on the kiosk's own session: no root, no write access to sysfs). A box
  # nobody paired behaves as before, and its backlight is never touched.
  claimedTicks = 12;
  blackAfterSec = 60;
  idleStep = if cfg.sleepAfterSec == null then blackAfterSec else lib.min blackAfterSec cfg.sleepAfterSec;
  sleepFor =
    let
      s = cfg.sleepAfterSec;
    in
    if lib.mod s 60 == 0 then "${toString (s / 60)} min" else "${toString s} s";
  # The console's state as the loop needs it, two words: the desk's (day, dim, black for a paired screen; unpaired; none
  # when the API has no desk) and the claim state. Never black while the screen is unlocked (NX-170): someone is using
  # it (a Talk waiting for its answer), so it is dim until Whombat locks it again. A device waiting to sign in at the
  # screen (`signin`, NX-304, Whombat BX-06) comes first, paired or not: the screen is awake at the day's level while
  # its code shows, whatever the hour.
  modeQuery =
    if cfg.desk then
      ''[(if .claim.signIn != null then "signin" elif .desk == null then "none" elif .desk.paired == null then "unpaired" elif .desk.paired.quiet then (if .desk.paired.night == "black" and .desk.lock.state != "unlocked" then "black" else "dim" end) else "day" end), (.claim.state // "")] | join(" ")''
    else
      ''[(if .claim.signIn != null then "signin" else "none" end), (.claim.state // "")] | join(" ")'';
  # A paired screen's mode outlasts an API without a desk this long (the runtime restarting, an update at night: the
  # room mustn't light up); a screen that is unpaired says so.
  deskHoldSec = 600;
  sleepingBrowser = pkgs.writeShellApplication {
    name = "whombat-kiosk-browser";
    # Not errexit: a failing wait, curl or kill is an answer here, not an error.
    bashOptions = [ "nounset" ];
    # sh for swayidle's commands.
    runtimeInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.procps
      pkgs.curl
      pkgs.jq
      cfg.swayidlePackage
      config.systemd.package
    ];
    text = ''
      profile=$1 url=$2
      token=''${url##*#t=}
      # Idle since when (bash's SECONDS; "" while the console is used), the console's mode, claimed in how many polls.
      idle_since="" mode="" claimed=0
      trap 'idle_since=$((SECONDS - ${toString idleStep}))' USR1
      trap 'idle_since=""' USR2
      # swayidle and any pending tick go with the loop (cage ends once every holder of its child's pipe has).
      # shellcheck disable=SC2046
      trap 'kill $(jobs -p) 2>/dev/null' EXIT
      swayidle -C /dev/null timeout ${toString idleStep} "kill -USR1 $$" resume "kill -USR2 $$" &
      ${setupOutputs}
      ${outputsCommand}
      ${chromiumCommand}

      # readMode: the console's mode from its API into `got`: signin while a device waits for the code on the screen,
      # day, dim or black for a paired desk screen, else the claim state; "" when it doesn't answer. While the API has
      # no desk (the runtime away) a paired screen's last mode holds for ${toString deskHoldSec} s (`held`).
      held="" held_at=0 got=""
      readMode() {
        local out d c
        got=""
        out=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
          curl -fsS --noproxy '*' --max-time 4 --config - ${origin}/api/state 2>/dev/null |
          jq -r '${modeQuery}' 2>/dev/null)
        [ -n "$out" ] || return 0
        read -r d c <<<"$out"
        case "$d" in
          signin) got=$d ;;
          day | dim | black) held=$d held_at=$SECONDS got=$d ;;
          none)
            if [ -n "$held" ] && [ $((SECONDS - held_at)) -lt ${toString deskHoldSec} ]; then
              got=$held
            else
              held="" got=''${c:-}
            fi
            ;;
          *) held="" got=''${c:-} ;;
        esac
      }
      idleFor() {
        if [ -n "$idle_since" ]; then echo $((SECONDS - idle_since)); else echo 0; fi
      }
      poll() {
        readMode
        mode=$got
        if [ "$mode" = claimed ]; then claimed=$((claimed + 1)); else claimed=0; fi
        light awake
      }
      # Whether the console sleeps now: claimed and unused for sleepAfterSec, or a paired screen at night set to black
      # and unused for blackAfterSec. Never while a sign-in's code shows (signin).
      sleepy() {
        case "$mode" in
          claimed) [ "$claimed" -ge ${toString claimedTicks} ] && [ "$(idleFor)" -ge ${toString cfg.sleepAfterSec} ] ;;
          black) [ "$(idleFor)" -ge ${toString blackAfterSec} ] ;;
          *) return 1 ;;
        esac
      }

      # The panel's backlight (desk only): firmware, then platform, then raw interfaces, as systemd-backlight ranks them.
      bl=""
      ${lib.optionalString cfg.desk ''
        rank=9
        for d in /sys/class/backlight/*; do
          [ -r "$d/max_brightness" ] || continue
          case "$(cat "$d/type" 2>/dev/null)" in firmware) r=0 ;; platform) r=1 ;; raw) r=2 ;; *) r=3 ;; esac
          if [ "$r" -lt "$rank" ]; then bl=''${d##*/} rank=$r; fi
        done
      ''}
      lit="" day_level=""
      # light awake|asleep: the backlight for the mode. lit is what the loop set (night, off; "" = the day's level,
      # never changed or given back); day_level is the panel's level before the loop first took it down.
      light() {
        [ -n "$bl" ] || return 0
        local want max night cur v
        case "$mode" in
          "") return 0 ;;
          dim) want=night ;;
          black) if [ "$1" = asleep ]; then want=off; else want=night; fi ;;
          *) want=day ;;
        esac
        [ "$want" = "''${lit:-day}" ] && return 0
        max=$(cat "/sys/class/backlight/$bl/max_brightness" 2>/dev/null) || return 0
        night=$((max * ${toString cfg.brightness.night} / 100))
        [ "$night" -ge 1 ] || night=1
        if [ -z "$lit" ]; then
          cur=$(cat "/sys/class/backlight/$bl/brightness" 2>/dev/null || echo 0)
          [ "$cur" -gt "$night" ] && day_level=$cur
        fi
        case "$want" in
          day) v=''${day_level:-$((max * ${toString cfg.brightness.day} / 100))} ;;
          night) v=$night ;;
          *) v=0 ;;
        esac
        if busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto org.freedesktop.login1.Session \
          SetBrightness ssu backlight "$bl" "$v" >/dev/null; then
          if [ "$want" = day ]; then lit=""; else lit=$want; fi
          echo "whombat-kiosk: the backlight is at $v of $max ($want)" >&2
        fi
      }

      # nap SECONDS: a sleep that a signal from swayidle ends at once.
      nap() {
        sleep "$1" &
        local s=$!
        wait "$s" 2>/dev/null || kill "$s" 2>/dev/null
        return 0
      }
      # Chromium's browser process exits on SIGTERM and takes its helpers along; whatever is left after 10 s goes
      # (NX-87: one that hangs must not keep the console from sleeping or waking).
      stopChromium() {
        kill -TERM "$1" 2>/dev/null
        for _ in $(seq 20); do
          kill -0 "$1" 2>/dev/null || break
          nap 0.5
        done
        pkill -KILL -u whombat-kiosk -f /libexec/chromium/ || true
        wait "$1" 2>/dev/null || true
      }

      while :; do
        rm -rf "$profile"
        mkdir -m 0700 "$profile"
        light awake
        ${cfg.chromiumPackage}/bin/chromium ${lib.escapeShellArgs chromiumFlags} "''${sw[@]}" --user-data-dir="$profile" --app="$url" &
        pid=$!
        rc=""
        # Every 10 s, and at every signal: Chromium's end, or time to sleep.
        while [ -z "$rc" ]; do
          sleep 10 &
          tick=$!
          # A signal ends the wait with `who` unset.
          wait -n -p who "$pid" "$tick"
          st=$?
          [ "''${who:-}" = "$tick" ] || kill "$tick" 2>/dev/null
          if [ "''${who:-}" = "$pid" ]; then
            rc=$st
            break
          fi
          poll
          if sleepy; then
            stopChromium "$pid"
            rc=asleep
          fi
        done

        if [ "$rc" = asleep ]; then
          # The profile is on tmpfs (memory): it goes now, not at the next start.
          rm -rf "$profile"
          light asleep
          if [ "$mode" = black ]; then
            echo "whombat-kiosk: quiet hours; the screen is black until it is touched" >&2
          else
            echo "whombat-kiosk: nobody used the console for ${sleepFor}; it sleeps until a key press or pointer movement" >&2
          fi
          # Asleep until input, or until the console's state no longer sleeps (a mode that sleeps too keeps it asleep).
          while [ -n "$idle_since" ]; do
            nap 10
            [ -n "$idle_since" ] || break
            readMode
            m=$got
            if [ -z "$m" ] || [ "$m" = "$mode" ]; then continue; fi
            # A paired screen is claimed: one that stops being paired was claimed all along.
            if [ "$m" = claimed ]; then claimed=${toString claimedTicks}; else claimed=0; fi
            mode=$m
            if sleepy; then
              light asleep
              continue
            fi
            case "$mode" in
              signin) echo "whombat-kiosk: a device asks to sign in; the screen shows its code" >&2 ;;
              day | dim) echo "whombat-kiosk: the desk screen shows again" >&2 ;;
              claimed) echo "whombat-kiosk: this screen isn't paired any more; the console shows again" >&2 ;;
              *) echo "whombat-kiosk: this Whombat isn't claimed any more; the console shows again" >&2 ;;
            esac
            break
          done
          [ -n "$idle_since" ] || echo "whombat-kiosk: the console was used; it shows again" >&2
          continue
        fi
        [ "$rc" = 0 ] && continue
        [ "$(${vtActive})" = tty1 ] && exit "$rc"
        until [ "$(${vtActive})" = tty1 ]; do nap 1; done
      done
    '';
  };

  # Restart a running kiosk (not one that failed for good: the text console has tty1 then), without counting against
  # its start limit.
  restartKiosk = pkgs.writeShellScript "whombat-kiosk-restart" ''
    if ${config.systemd.package}/bin/systemctl is-active -q whombat-kiosk.service; then
      ${config.systemd.package}/bin/systemctl reset-failed whombat-kiosk.service
      ${config.systemd.package}/bin/systemctl --no-block restart whombat-kiosk.service
    fi
  '';

  # A display plugged in or out (NX-147): restart a running kiosk, not within 15 s of its start (a new cage's own mode
  # set must not restart it again). The 2 s first gather a burst into one restart: events while this runs start no
  # second run (a viewer window dragged to a new size sends many).
  restartForDisplay = pkgs.writeShellScript "whombat-kiosk-display" ''
    PATH=${
      lib.makeBinPath [
        pkgs.coreutils
        config.systemd.package
      ]
    }
    sleep 2
    since=$(systemctl show -P ActiveEnterTimestamp --timestamp=unix whombat-kiosk.service)
    since=''${since#@}
    case "$since" in "" | *[!0-9]*) exit 0 ;; esac
    if [ $(($(date +%s) - since)) -lt 15 ]; then
      echo "a display changed while the kiosk was starting: no restart"
      exit 0
    fi
    exec ${restartKiosk}
  '';

  # The box's own touchscreen on the box's own panel: cage maps a touchscreen to one output only when libinput
  # names one (udev's WL_OUTPUT); without it a touch lands across the whole layout, which with a monitor plugged in is
  # the wrong place. A touchscreen that is part of the machine (on I2C, SPI or the platform, or USB on a fixed port)
  # gets the panel's connector (eDP, LVDS or DSI) when exactly one is connected; anything else stays as it was.
  touchOutput = pkgs.writeShellScript "whombat-kiosk-touch-output" ''
    PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    internal=""
    case "''${ID_BUS:-}" in i2c | spi | platform | host | rmi) internal=1 ;; esac
    if [ -z "$internal" ]; then
      d=$1
      while [ -n "$d" ] && [ "$d" != /sys ]; do
        if [ -r "$d/removable" ] && [ -r "$d/idVendor" ]; then
          [ "$(cat "$d/removable")" = fixed ] && internal=1
          break
        fi
        d=''${d%/*}
      done
    fi
    [ -n "$internal" ] || exit 0
    panel=""
    for c in /sys/class/drm/card*-eDP-* /sys/class/drm/card*-LVDS-* /sys/class/drm/card*-DSI-*; do
      if [ -r "$c/status" ] && [ "$(cat "$c/status")" = connected ]; then
        [ -z "$panel" ] || exit 0
        n=''${c##*/}
        panel=''${n#card*-}
      fi
    done
    [ -z "$panel" ] || echo "WL_OUTPUT=$panel"
  '';

  # The relay's sockets (NX-401) start with it, after the server (which so makes its namespace as before), not at
  # sockets.target (the default, before every service): the host's would queue the boot's every device event for a
  # relay that doesn't run yet, and its first one would start the relay early.
  relaySocketDeps = {
    after = [
      "sysinit.target"
      cfg.serverUnit
    ];
    requires = [ "sysinit.target" ];
    before = [ "shutdown.target" ];
    conflicts = [ "shutdown.target" ];
    unitConfig.DefaultDependencies = false;
  };

  # The active VT (tty1, tty2, …).
  vtActive = pkgs.writeShellScript "whombat-vt-active" "exec ${pkgs.coreutils}/bin/cat /sys/class/tty/tty0/active";

  # Kill the kiosk's Chromium (every process whose command line names it; not cage, not the browser loop) (NX-87).
  stopBrowser = pkgs.writeShellScript "whombat-kiosk-stop" ''
    ${pkgs.procps}/bin/pkill -KILL -u whombat-kiosk -f chromium || true
  '';

  launcher = pkgs.writeShellApplication {
    name = "whombat-kiosk";
    runtimeInputs = [
      pkgs.coreutils
      cfg.cagePackage
    ];
    text = ''
      # 1. A display (CG-05): a DRM device of a real driver, or after drmWaitSec the firmware's framebuffer (simpledrm)
      #    if that is all there is. None at all: exit 3 (no restart; OnFailure= starts the text console).
      deadline=$((SECONDS + ${toString cfg.drmWaitSec}))
      while :; do
        real="" any=""
        for c in /sys/class/drm/card[0-9]*; do
          [ -e "$c" ] || continue
          case "''${c##*/}" in *-*) continue ;; esac
          any=1
          drv=$(readlink -f "$c/device/driver" 2>/dev/null || true)
          case "''${drv##*/}" in
            simpledrm | simple-framebuffer | efidrm | efi-framebuffer | vesadrm | vesa-framebuffer) ;;
            *) real=1 ;;
          esac
        done
        [ -n "$real" ] && break
        if [ "$SECONDS" -ge "$deadline" ]; then
          [ -n "$any" ] && break
          echo "whombat-kiosk: no display (no DRM device after ${toString cfg.drmWaitSec} s); the text console takes tty1" >&2
          exit 3
        fi
        sleep 0.5
      done

      # 2. The server's token (it writes the file before it tells systemd it is ready).
      token=""
      for _ in $(seq 100); do
        [ -r ${tokenFile} ] && token=$(head -c 256 ${tokenFile} | tr -dc 'A-Za-z0-9_-')
        [ -n "$token" ] && break
        sleep 0.1
      done
      [ -n "$token" ] || { echo "whombat-kiosk: no token in ${tokenFile}" >&2; exit 1; }

      # 3. tty1 is the active VT: cage started while another VT is (a restart after a crash while the operator is on
      #    tty2) would give up after 10 s waiting for its session and count as a failure (NX-88).
      until [ "$(${vtActive})" = tty1 ]; do sleep 1; done

      # 4. Software or the graphics chip (NX-161): a real GPU driver bound to a display's card, and the drivers there.
      render=software
      ${lib.optionalString cfg.gpu ''
        for c in /sys/class/drm/card[0-9]*; do
          case "''${c##*/}" in *-*) continue ;; esac
          drv=$(readlink -f "$c/device/driver" 2>/dev/null || true)
          case "''${drv##*/}" in ${lib.concatStringsSep " | " gpuDrivers}) render=gpu gpu=''${drv##*/} ;; esac
        done
        if [ "$render" = gpu ] && [ ! -e /run/opengl-driver/lib/dri ]; then render=software; fi
        if [ "$render" = gpu ]; then
          echo "whombat-kiosk: drawing with the graphics chip ($gpu)" >&2
        fi
      ''}

      # 5. cage with Chromium (VT switching allowed: -s; no client-side decorations: -d).
      export HOME="$RUNTIME_DIRECTORY" XDG_RUNTIME_DIR="$RUNTIME_DIRECTORY" TMPDIR="$RUNTIME_DIRECTORY/tmp"
      mkdir -m 0700 "$TMPDIR"
      export WLR_NO_HARDWARE_CURSORS=1 XCURSOR_SIZE=24 WHOMBAT_KIOSK_RENDER=$render
      # cage's and Chromium's pointers from the empty theme (noPointer); the page draws its own while a mouse moves.
      export XCURSOR_PATH=${noPointer}/share/icons XCURSOR_THEME=default
      # No input device yet is no failure (NX-405): at boot udevd may not have finished them when cage starts, and
      # every keyboard, mouse or touchscreen that comes later reaches cage (in the server's namespace through
      # whombat-kiosk-udev, NX-400).
      export WLR_LIBINPUT_NO_DEVICES=1
      ${lib.optionalString cfg.desk ''
        # The sound server's PulseAudio socket (HD-04, NX-255): a path socket, so it works from the server's network
        # namespace and on the read-only /run.
        export PULSE_SERVER=${config.whombat.sound.pulseServer}
      ''}
      # wlroots picks GLES2 (or Vulkan) by itself on a real chip; in software it is pixman.
      [ "$render" = gpu ] || export WLR_RENDERER=pixman
      profile="$RUNTIME_DIRECTORY/chromium"
      url="${cfg.url}#t=$token"
      unset token
      exec cage -d -s -- ${browser} "$profile" "$url"
    '';
  };
in
{
  imports = [ ./sound.nix ];

  options.whombat.kiosk = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "The graphical kiosk on tty1 (cage + Chromium showing the local server's page, CG-01).";
    };
    port = mkOption {
      type = types.port;
      description = "The local server's port on 127.0.0.1 (the only origin Chromium may open).";
    };
    path = mkOption {
      type = types.str;
      default = "/";
      description = "The page's path.";
    };
    url = mkOption {
      type = types.str;
      default = "${origin}${cfg.path}";
      defaultText = lib.literalExpression ''"http://127.0.0.1:''${port}''${path}"'';
      readOnly = true;
    };
    tokenDir = mkOption {
      type = types.str;
      description = "Directory of the server's token file (`token`); created 2750 <tokenOwner>:whombat-kiosk.";
    };
    tokenOwner = mkOption {
      type = types.str;
      description = "The server's user (it writes the token).";
    };
    serverUnit = mkOption {
      type = types.str;
      description = "The server's unit (Type=notify: ready once it listens and wrote the token).";
    };
    joinServerNetwork = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Run in the server unit's private network namespace (both PrivateNetwork=, JoinsNamespaceOf=): the kiosk sees
        the server's loopback and no network. false: the host's network namespace (the installer).
      '';
    };
    fallbackUnit = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Started when the kiosk fails for good (OnFailure=): what shows tty1 instead.";
    };
    drmWaitSec = mkOption {
      type = types.int;
      default = 15;
      description = "How long to wait for a DRM device before giving tty1 to the fallback (CG-05).";
    };
    uid = mkOption {
      type = types.nullOr types.int;
      default = null;
      description = "Fixed uid/gid of whombat-kiosk (the appliance's ids, NX-08); null picks one.";
    };
    chromiumPackage = mkOption {
      type = types.package;
      default = pkgs.chromium;
      defaultText = lib.literalExpression "pkgs.chromium";
    };
    cagePackage = mkOption {
      type = types.package;
      default = pkgs.cage;
      defaultText = lib.literalExpression "pkgs.cage";
    };
    sleepAfterSec = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      example = 600;
      description = ''
        The console sleeps (NX-147): after this long without input on a claimed box Chromium stops and the screen is
        black until the next input. The state is the server's Console API's `claim.state`. null: never (the installer).
      '';
    };
    gpu = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Draw with the graphics chip where a real one drives the display (${lib.concatStringsSep ", " gpuDrivers}): the
        drivers (hardware.graphics, mesa: about 840 MB of closure), cage's GLES2 renderer, Chromium with the GPU and
        without forced reduced motion (NX-161). VMs and firmware framebuffers keep software rendering even then. false
        (the default, NX-169): always software, no GPU drivers in the closure.
      '';
    };
    desk = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The desk display (Whombat DK-08, DK-09; NX-162, NX-163, NX-255): the page may use the microphone and play sound
        (its origin only) through the sound server (`whombat.sound`, PipeWire), sound cards are set up at boot, and the
        sleeping loop follows the Console API's `desk`: a paired
        screen never sleeps in the day, and in quiet hours the backlight dims (or the screen goes black a minute after
        the last touch). Needs `sleepAfterSec`.
      '';
    };
    transform = mkOption {
      type = types.enum [
        "auto"
        "normal"
        "90"
        "180"
        "270"
        "flipped"
        "flipped-90"
        "flipped-180"
        "flipped-270"
      ];
      default = "auto";
      description = ''
        How the display is turned (NX-164, through cage's wlr-output-management): `auto` turns a panel whose mode is
        taller than wide by 90° to landscape, `normal` leaves every display as it is, any other value turns every display.
      '';
    };
    brightness = {
      day = mkOption {
        type = types.ints.between 1 100;
        default = 80;
        description = "A paired screen's backlight after the night when its level before is unknown (percent, NX-162).";
      };
      night = mkOption {
        type = types.ints.between 1 100;
        default = 10;
        description = "A paired screen's backlight in quiet hours (percent of the panel's maximum, at least one step).";
      };
    };
    wlrRandrPackage = mkOption {
      type = types.package;
      default = pkgs.wlr-randr;
      defaultText = lib.literalExpression "pkgs.wlr-randr";
      description = "Turns the display (`transform`).";
    };
    udevRelayPackage = mkOption {
      type = types.package;
      default = pkgs.whombat-kiosk-udev;
      defaultText = lib.literalExpression "pkgs.whombat-kiosk-udev";
      description = "Passes udevd's input device events into the server's network namespace (`joinServerNetwork`, NX-400).";
    };
    swayidlePackage = mkOption {
      type = types.package;
      default = pkgs.swayidle;
      defaultText = lib.literalExpression "pkgs.swayidle";
      description = "Idle input inside cage (ext-idle-notify-v1), for `sleepAfterSec`.";
    };
    launcher = mkOption {
      type = types.package;
      default = launcher;
      readOnly = true;
      internal = true;
    };
    browser = mkOption {
      type = types.str;
      default = "${browser}";
      readOnly = true;
      internal = true;
      description = "The browser loop cage runs (checks.console reads it).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.desk -> cfg.sleepAfterSec != null;
        message = "whombat.kiosk.desk follows the desk's state in the sleeping loop: set whombat.kiosk.sleepAfterSec.";
      }
    ];

    # The graphics chip's drivers (mesa: GLES2/EGL for cage, GL and Vulkan for Chromium's GPU process; NX-161).
    hardware.graphics.enable = lib.mkIf cfg.gpu true;

    # Sound cards set up as they appear (NX-163): `alsactl init` runs the card's UCM boot sequence (alsa-ucm-conf) or
    # alsa's generic init, so the speakers and the microphone are on and at a sane level. (The rule is with the kiosk's
    # other udev rules below.) Chromium plays and records through the sound server (HD-04, NX-255): system-wide
    # PipeWire, whose WirePlumber picks the microphone and the speaker among all the cards, through its PulseAudio
    # socket; logind still gives the kiosk's session the cards (uaccess), which nothing of the kiosk opens now.
    whombat.sound = lib.mkIf cfg.desk {
      enable = true;
      users = [ "whombat-kiosk" ];
    };

    users.users.whombat-kiosk = {
      isSystemUser = true;
      uid = cfg.uid;
      group = "whombat-kiosk";
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-kiosk.gid = cfg.uid;

    systemd.tmpfiles.settings."22-whombat-kiosk".${cfg.tokenDir}.d = {
      mode = "2750";
      user = cfg.tokenOwner;
      group = "whombat-kiosk";
    };

    environment.etc."chromium/policies/managed/whombat-kiosk.json".text = builtins.toJSON policies;

    # The seat's session: pam_systemd registers it with logind on seat0 / VT 1 (from the unit's TTYPath), which gives
    # cage the DRM and input devices through libseat. user-light: no systemd --user instance for the kiosk.
    security.pam.services.whombat-kiosk = {
      useDefaultRules = false;
      rules = {
        account.unix = {
          order = 10000;
          control = "required";
          modulePath = "${config.security.pam.package}/lib/security/pam_unix.so";
        };
        session.unix = {
          order = 10000;
          control = "required";
          modulePath = "${config.security.pam.package}/lib/security/pam_unix.so";
        };
        session.systemd = {
          order = 10100;
          control = "required";
          modulePath = "${config.systemd.package}/lib/security/pam_systemd.so";
          settings.class = "user-light";
        };
      };
    };

    # A fallback font for Chromium (the page brings its own fonts), and fontconfig to find it: the installer's
    # minimal profile turns fontconfig off, and without it Chromium drew no text in the page's regular and medium
    # weights (the installer showed a title and empty boxes, NX-88).
    fonts.packages = [ pkgs.dejavu_fonts ];
    fonts.fontconfig.enable = lib.mkForce true;

    # Every start of the server makes a new token: a kiosk that is running (the server restarted under it) starts again
    # to read it. Not at boot (the kiosk isn't running yet) and not after it failed for good (the text console has
    # tty1 then).
    # The restart doesn't count against the kiosk's start limit (reset-failed resets it): only its own failures do.
    systemd.services.${lib.removeSuffix ".service" cfg.serverUnit}.serviceConfig.ExecStartPost = [
      "+${restartKiosk}"
    ];

    # In the server's network namespace the kiosk gets no udev events of its own (udevd's netlink messages stay in the
    # host's namespace, NX-82). The input devices' are passed into it (whombat-kiosk-udev, below), so cage's libinput adds
    # a keyboard or mouse plugged in after it started, a Bluetooth one at every connection, as it would anywhere: no
    # restart, the page stays (NX-400). Keyboards and mice present at boot are there before the kiosk starts. A display
    # plugged in or out (a DRM hotplug event) still restarts a running kiosk: a new cage lights the new monitor at its
    # preferred mode and turns it (`transform`), which a running one doesn't; a new cage is awake (NX-147, NX-402).
    services.udev.extraRules = lib.mkMerge [
      # The box's own touchscreen on its own panel; its card comes later at boot than the touchscreen may, so
      # a card that appears asks the touchscreens again.
      ''
        ACTION=="add|change", SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHSCREEN}=="1", IMPORT{program}="${touchOutput} %S%p"
        ACTION=="add", SUBSYSTEM=="drm", KERNEL=="card[0-9]*", RUN+="${config.systemd.package}/bin/udevadm trigger --action=change --subsystem-match=input --property-match=ID_INPUT_TOUCHSCREEN=1"
      ''
      (lib.mkIf cfg.joinServerNetwork ''
        ACTION=="change", SUBSYSTEM=="drm", ENV{HOTPLUG}=="1", TAG+="systemd", ENV{SYSTEMD_WANTS}+="whombat-kiosk-display.service"
      '')
      (lib.mkIf cfg.desk ''
        ACTION=="add", SUBSYSTEM=="sound", KERNEL=="controlC*", KERNELS!="card*", RUN+="${pkgs.alsa-utils}/bin/alsactl -g init $attr{device/number}"
      '')
    ];
    systemd.services.whombat-kiosk-display = lib.mkIf cfg.joinServerNetwork {
      description = "Restart the kiosk for a display plugged in or out";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = restartForDisplay;
      };
    };

    # The relay (NX-400, NX-401) gets both of its sockets of the uevent netlink family from systemd and makes none:
    # `host` in the host's namespace on udevd's group (2), `kiosk` in the server's (this socket unit joins it, as the
    # kiosk does). It passes udevd's messages of the input subsystem from the one to the other, byte for byte, and
    # libudev in cage takes them as udevd's. Root (libudev believes uid 0) with CAP_NET_ADMIN alone (a send to a group
    # of this family needs it), in an empty network namespace of its own and without any address family.
    systemd.sockets.whombat-kiosk-udev-host = lib.mkIf cfg.joinServerNetwork (
      relaySocketDeps
      // {
        description = "udevd's device events for the kiosk";
        socketConfig = {
          ListenNetlink = "kobject-uevent 2";
          PassCredentials = true;
          # A burst (`udevadm trigger`) is every device's event; only the input ones are passed.
          ReceiveBuffer = "8M";
          FileDescriptorName = "host";
          Service = "whombat-kiosk-udev.service";
        };
      }
    );
    # This one is made in the server's namespace, which it joins; PrivateTmp= as the server and the kiosk have it:
    # whichever unit makes the namespace they share decides whether their /tmp is private too (NX-401).
    systemd.sockets.whombat-kiosk-udev-kiosk = lib.mkIf cfg.joinServerNetwork (
      lib.recursiveUpdate relaySocketDeps {
        description = "The kiosk's end of its udev events (the console server's network namespace)";
        unitConfig.JoinsNamespaceOf = cfg.serverUnit;
        socketConfig = {
          ListenNetlink = "kobject-uevent";
          FileDescriptorName = "kiosk";
          Service = "whombat-kiosk-udev.service";
          PrivateNetwork = true;
          PrivateTmp = true;
        };
      }
    );
    systemd.services.whombat-kiosk-udev = lib.mkIf cfg.joinServerNetwork {
      description = "Pass udevd's input device events to the kiosk (its keyboards and mice plugged in later)";
      wantedBy = [ "whombat-kiosk.service" ];
      before = [ "whombat-kiosk.service" ];
      requires = [
        "whombat-kiosk-udev-host.socket"
        "whombat-kiosk-udev-kiosk.socket"
      ];
      after = [
        "whombat-kiosk-udev-host.socket"
        "whombat-kiosk-udev-kiosk.socket"
      ];
      serviceConfig = {
        ExecStart = "${cfg.udevRelayPackage}/bin/whombat-kiosk-udev --subsystems input";
        Sockets = [
          "whombat-kiosk-udev-host.socket"
          "whombat-kiosk-udev-kiosk.socket"
        ];
        StandardInput = "null";
        StandardOutput = "journal";
        StandardError = "journal";
        Restart = "always";
        RestartSec = 1;
        CapabilityBoundingSet = "CAP_NET_ADMIN";
        AmbientCapabilities = "";
        NoNewPrivileges = true;
        PrivateNetwork = true;
        RestrictAddressFamilies = "none";
        IPAddressDeny = "any";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RestrictNamespaces = true;
        RemoveIPC = true;
        UMask = "0077";
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        LimitCORE = 0;
        MemoryMax = "32M";
      };
    };

    systemd.services.whombat-kiosk = {
      description = "Whombat kiosk (the graphical ${
        if cfg.joinServerNetwork then "console" else "installer"
      } on tty1)";
      wantedBy = [ "multi-user.target" ];
      after = [
        cfg.serverUnit
        "systemd-user-sessions.service"
        "systemd-logind.service"
        "dbus.socket"
        "systemd-vconsole-setup.service"
        "plymouth-quit-wait.service"
      ];
      # Wants, not Requires: every restart from outside (a restarted server with its new token, a display plugged in)
      # goes through restartKiosk, which resets the start count, so only the kiosk's own failures in a row count.
      wants = [
        "dbus.socket"
        "systemd-logind.service"
        cfg.serverUnit
      ];
      conflicts = [
        "getty@tty1.service"
        "autovt@tty1.service"
      ];
      onFailure = lib.optional (cfg.fallbackUnit != null) cfg.fallbackUnit;
      unitConfig = {
        # Three failures in a row (within five minutes: the start after the third one is the fourth, refused): the unit
        # fails for good and OnFailure= runs.
        StartLimitIntervalSec = 300;
        StartLimitBurst = 3;
        JoinsNamespaceOf = lib.mkIf cfg.joinServerNetwork cfg.serverUnit;
        ConditionPathExists = "/dev/tty1";
      };
      serviceConfig = {
        ExecStart = "${launcher}/bin/whombat-kiosk";
        User = "whombat-kiosk";
        Group = "whombat-kiosk";
        PAMName = "whombat-kiosk";
        TTYPath = "/dev/tty1";
        TTYReset = true;
        TTYVHangup = true;
        TTYVTDisallocate = true;
        StandardInput = "tty-fail";
        StandardOutput = "journal";
        StandardError = "journal";
        Restart = "always";
        RestartSec = 2;
        # OnFailure= only once the kiosk has failed for good, not at every restart (systemd triggers it on each).
        RestartMode = "direct";
        # No display: don't retry, fall back at once.
        RestartPreventExitStatus = 3;
        # Now and then Chromium doesn't exit after cage's SIGTERM breaks its Wayland connection: cage waits for it, the
        # stop times out (90 s by default, tty1 dark) and the timeout fails the unit, so OnFailure= gives tty1 to the
        # text console. The kiosk keeps nothing worth a graceful exit (a fresh profile every start), so a stop kills
        # Chromium first and cage then ends at once; the short timeout is the backstop (NX-87).
        ExecStop = "-${stopBrowser}";
        TimeoutStopSec = 5;
        RuntimeDirectory = "whombat-kiosk";
        RuntimeDirectoryMode = "0700";
        UMask = "0077";

        # Hardening (NX-82: what Chromium needs is relaxed, and why).
        PrivateNetwork = cfg.joinServerNetwork;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        # Not PrivateDevices=: libseat names the DRM and input devices by their /dev path (stat for the device number)
        # before logind opens them and hands cage the descriptors (TakeDevice). No DevicePolicy= either: pam_systemd
        # moves the processes into the session's scope, where the unit's cgroup settings (device and IP filters,
        # accounting) don't follow; everything below is per process and does.
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RemoveIPC = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        SystemCallArchitectures = "native";
        LimitCORE = 0;
        # Relaxed for Chromium: V8 compiles JavaScript to machine code (writable+executable memory), Chromium's own
        # sandbox makes user, pid and network namespaces, chroots into an empty directory and installs seccomp filters
        # (@sandbox), and it tolerates EPERM from the calls it doesn't get where SIGSYS would kill it.
        MemoryDenyWriteExecute = false;
        RestrictNamespaces = [
          "user"
          "pid"
          "net"
        ];
        SystemCallFilter = [
          "@system-service"
          "@sandbox"
          "chroot"
        ];
        SystemCallErrorNumber = "EPERM";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
      };
    };
  };
}
