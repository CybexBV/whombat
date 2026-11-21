# Workstream: Bluetooth — pair keyboards, mice, speakers and headphones with the box (2026-10-20)

John, 2026-10-20 (main checkout), after the newest kernel (hardware-support.md HD-12) left Bluetooth at the driver level
and he asked whether “Bluetooth pairing” meant linking the phone app: “Implement your original idea so we can pair
keyboards, mice, speakers, etc”.

What was there (appliance main 6a220a4): the kernel's Bluetooth drivers (`btusb`, `btintel`, `btrtl`, `btmtk`, `btqca`)
and their firmware load and the hardware report lists the adapter (appliance MG-110), but BlueZ is off and WirePlumber's
Bluetooth monitor is off (appliance NX-255, NX-343), so nothing can pair or use a device.

Numbering: BT-01… here; server BT-S01… (`bluetooth-server.md`); contracts CT-670…CT-699 (0.109.0); app AP-3700…AP-3749
web (`bluetooth-web.md`), AP-3750…AP-3799 Android (`bluetooth-android.md`); appliance NX-350…NX-369 (`nixos.md`),
CG-200…CG-229 (`console-gui.md`). Build brief: `docs/implementation/bluetooth/assignment.md`.

## Decided

- **BT-01 The box pairs what you use with it**: keyboards, mice and trackpads, speakers, headphones, headsets and game
  controllers. Phones and computers are left out of the list (pairing them would do nothing here). *Why:* a desk box
  without a touch screen needs a keyboard and a mouse, and its sound and Talk are better on a speaker or headphones.
- **BT-02 Owners pair from the app; anyone at the screen when it may change.** In the app (web and Android): Settings →
  This Whombat → Overview → **Bluetooth**, owners only, like Network (HD-06). On the box's screen: when the box isn't
  claimed yet, or the screen is unlocked (the desk PIN or the phone, DK-04); otherwise the screen shows the paired devices
  and says to unlock or use the app. *Why:* a keyboard paired to a box can type into it, so the same people who may change
  the box's network may add one; a box without a keyboard or touch screen gets its first one from the app.
- **BT-03 The box finds the device, never the other way round.** You put the device in pairing mode, the box looks for
  devices for a minute, you choose yours. The box is never discoverable, and it accepts a pairing only while one that an
  owner started is running (no pairing agent otherwise, so BlueZ refuses everything else). *Why:* nobody nearby can pair
  something with a box that nobody asked to pair.
- **BT-04 Codes are shown, not typed.** A keyboard that needs a code gets one the box makes: “Type 123456 on the keyboard,
  then press Enter.”, with the digits typed so far shown as they arrive. A device with its own screen that shows a number
  is confirmed (“Does {name} show 123456?”). Mice, speakers and headphones pair without a code. Devices that want a code
  typed into the box are refused (none of BT-01's kinds do). *Why:* BlueZ's agent capability *DisplayYesNo* gives exactly
  these three cases for BT-01's devices.
- **BT-05 Paired devices come back by themselves.** A paired device is trusted: keyboards, mice and most speakers
  reconnect when they're switched on. Each paired device can be **connected** or **disconnected** from its row (a speaker
  you want to stop using without switching it off), and **removed** (it has to be paired again). *Why:* that's what
  people expect from a laptop.
- **BT-06 Sound goes to a connected speaker or headphones.** While one is connected the box's sounds and Talk's spoken
  answers play there; when it disconnects they go back to the box's own speaker. Talk listens with the box's own
  microphone, or with a headset's when the box has none (WirePlumber's choices, appliance NX-35x). *Why:* the newest
  sound device is the one someone just switched on to use.
- **BT-07 One pairing at a time, a minute to find, a minute and a half to pair.** Looking runs 60 s (asked again, it runs
  on); a pairing stops looking and has 90 s. A second pairing while one runs is refused (`busy`). *Why:* BlueZ pairs one
  device at a time and looking slows pairing down.
- **BT-08 Pairings live on the box only.** BlueZ's own state (`/var/lib/bluetooth`, root only); not in backups; a factory
  reset removes it (as Wi-Fi's, NX-247). Pairing and removing a device are signed events in the appliance's audit chain
  (`bluetooth.device_paired`, `bluetooth.device_removed`, as HD-S06 did for Wi-Fi). *Why:* the box's devices are the box's,
  like its network.
- **BT-09 Only the Bluetooth service talks to BlueZ.** A small service of the appliance (`whombat-bluetooth`, its own
  user) answers the runtime on a local socket, as presence and voice do; the D-Bus policy lets only it, root and the sound
  server reach BlueZ (the kiosk's browser, agents and their computers can't). *Why:* BlueZ trusts every local client by
  default.
- **BT-10 Device addresses reach owners, not reports.** The app and the screen get each device's Bluetooth address as its
  handle (it is broadcast over the air anyway); the hardware report still has no addresses (HD-03), and logs name devices,
  not addresses.
- **BT-11 Words** (concise-replies): **Bluetooth**, “Add a device”, “Looking for devices…”, “Put your device in pairing
  mode. Keyboards and mice often have a button for it; speakers and headphones usually need the power button held.”,
  “Pairing with {name}…”, “Type {code} on {name}, then press Enter.”, “Does {name} show {code}?” (**Yes** / **No**),
  “{name} is ready.”, “Connected”, “Connected · Battery 80 %”, “Not connected”, **Connect**, **Disconnect**, **Remove**,
  “Remove {name}? You’ll need to pair it again to use it.”; failures: “{name} didn’t accept the pairing. Put it in pairing
  mode and try again.”, “{name} didn’t answer in time. Put it in pairing mode and try again.”, “{name} isn’t nearby any
  more.”, “Pairing with {name} didn’t work. Try again.”; missing: “This Bluetooth adapter has no driver yet.”, “Bluetooth
  is switched off.”; the locked screen: “Unlock the screen to add or remove devices, or use the app.”; kinds: Keyboard,
  Mouse, Headphones, Headset, Speaker, Game controller, Device. Kinds, phases and failures cross the wire; the words are
  made where they're shown (app and console).
- **BT-12 A keyboard or mouse that reconnects doesn't restart the screen** (2026-10-21; appliance NX-400…NX-405, fixing
  NX-360). The box's screen used to find a keyboard or mouse connected after it started only by restarting (a few seconds,
  the page reloaded), and a Bluetooth one reconnects each time it wakes from its own sleep. Now the screen picks up every
  keyboard, mouse or touchscreen that comes later as it is, Bluetooth or USB. *Why:* a paired keyboard that wakes up must
  just type; a display plugged in or out still restarts the screen (rare, and a new start lights it properly).

## Not now

Bluetooth in the installer, the box being discoverable (a device starting the pairing), phones and computers, file
transfer, LE Audio and Auracast, choosing which of two connected speakers plays, a Bluetooth name for the box other than
BlueZ's default, setting a box up from the phone over Bluetooth, unlocking the screen when the owner's phone is near.
