# Workstream: the desk display — Whombat on a screen you can see and touch (2026-10-20)

John, 2026-10-20 (main checkout): “Currently we only use Whombat appliances on VMs and therefore it's not important what
runs on the monitor, however I am planning to run Whombat on a ROG Flow Z13 for example and it would be awesome if we can
actually do something with the screen when we have this on our desk.” I proposed a desk display (glance, answer with an
unlock, talk, battery as a UPS) with four mockups (appliance `docs/design/desk-display/`); John: “I love it, yes implement
this fully as you designed it.”

What was there: the console (appliance `docs/decisions/console-gui.md` CG-01…CG-36) is a kiosk (cage + Chromium, no
network, software rendering) that shows the claim code, then the burrow's name and wombat facts, and goes black after 10
minutes. By design it knows nothing about the box (CG-08). The machine in mind is an ASUS ROG Flow Z13 (2025): AMD Strix
Halo, up to 128 GB, 13.4″ 2560×1600 touch screen, kickstand, detachable keyboard cover, battery, microphones and
speakers, no Ethernet port.

Numbering: DK-01… here; server DK-S01… (`desk-display-server.md`), talk DK-T01… (`desk-display-talk.md`); contracts
CT-517… (0.100.0); app AP-3000…AP-3049 web (`desk-display-web.md`), AP-3050…AP-3099 Android (`desk-display-android.md`);
appliance CG-37… (`console-gui.md`, the page), NX-160… (`nixos.md`, kiosk/host/voice), MG-69… (`manager.md`), candidate
IN-320. Build brief: `docs/implementation/desk-display/assignment.md`.

## Decided

- **DK-01 A paired screen becomes a desk display; nothing else changes.** Once an owner pairs the box's own screen (DK-02),
  the console shows Whombat (DK-03…DK-08). A box nobody paired keeps today's console exactly: claim code, claimed
  screen, sleep after 10 minutes. *Why:* VMs and boxes in a cupboard have nobody looking at their screen; the desk is the
  machine on someone's desk.
- **DK-02 Pairing proves you're at the screen.** Settings → This Whombat → Screen → **Pair the screen** (owners). The
  screen then shows four letters for 10 minutes (the claim code's alphabet); typing them in Settings and choosing a
  6-digit PIN pairs it to that person. Five wrong tries make new letters. One person per screen: pairing again replaces
  the last pairing (Settings says whose it is first). **Unpair** in Settings. The screen shows the paired person's
  burrow. *Why:* the letters only appear on that screen, so whoever types them is there; one person keeps “Unlock as
  John” simple.
- **DK-03 Locked, it shows; it doesn't act.** The glance (mockup 1): clock and date, a one-line status, Needs you,
  Working on, Done today, up to four servers and up to four home tiles, and the power line. What shows **while locked**
  is the paired person's choice: *Only the time* (clock and an “all fine / something needs you” line), *A summary*
  (default: status line from counts, how many things need you, servers, home tiles, power; no titles or message words),
  or *Everything* (also the asks' titles, what the assistant is working on, Done today and its own status line). *Why:*
  anyone walking past can read the screen; message words stay off it unless the person wants them there.
- **DK-04 Unlock with a PIN or your phone.** Touch the screen, type the PIN (mockup 2) or press *Confirm on your phone*:
  the paired person's phone gets a notification and the web app a notice, “Your desk screen wants to unlock”, with
  Unlock and No (valid 2 minutes). Unlocked, the screen shows everything and acts as that person; it locks again 2
  minutes after the last touch, or at once with the lock button. Five wrong PINs: wait 1 minute, doubling up to an hour,
  and the person gets one message (“Someone typed a wrong PIN on your desk screen five times.”). The unlock is held by
  Whombat, not the page, so a kiosk restart (a keyboard cover attached) keeps it. *Why:* a PIN is quick at a desk; the
  phone is there for people who'd rather not type one.
- **DK-05 Answer asks on the screen; risky ones stay on the phone.** Unlocked, tapping a Needs you row opens it (mockup 2):
  the assistant's question, what happens, the command or target, and **Approve** (the ask's own words, e.g. “Restart
  Plex”) · **Not now** · **Ask** (opens Talk). Approve once only: no Approve later, no “always”. Asks about the Vault,
  money, deploying, merging or pushing to main, deleting, giving keys or messaging people outside never get buttons on the
  screen: “Answer this on your phone.” Whombat enforces this, not the page (`deskMayDecide`, contracts). A question the
  assistant asked in Chat opens Talk, which starts a new thread for now (answering in the question's own thread needs
  the talk request to name the ask: DK-15). **Not now** snoozes the ask until tomorrow, as on Home; it is not a no
  (DK-S19). *Why:* the screen is for the everyday “restart Plex?”; what can't
  be undone needs the person's own device.
- **DK-06 Talk to the assistant (mockup 3).** **Superseded in part by dictation.md DT-37, DT-38**: the mic is voice
  typing (tap, speak, *Done*, the words wait in Talk's box until *Send*), not hold to talk or the space bar; the rest
  holds. Unlocked: hold the button or the space bar and speak, or type when the
  keyboard cover is on. Speech becomes text on the box itself (whisper.cpp), the question goes into the person's Chat as
  a new thread (a follow-up within 2 minutes continues it), the assistant answers in one or two short sentences meant to
  be heard, the screen shows and speaks the answer (Kokoro since DK-36, on the box), with the server or thing it is about. The
  thread stays in Chat like any other. *Why:* the quickest way to ask “is pve-02 okay?” from your chair, and nothing
  spoken leaves the box.
- **DK-07 The microphone is open only while you hold to talk.** **Superseded in part by dictation.md DT-37**: it is open
  from the tap until *Done* or *Cancel* (five minutes at most); never on a locked screen, no wake word and no recording
  kept still hold. Never on a locked screen, no wake word, no recording kept:
  the audio is deleted once it is text, and the answer's audio once it has played (it lives in memory for 10 minutes for
  a replay). Talk can be turned off in Settings; it is off by itself when the machine has no microphone. *Why:* a desk
  device that listens all the time is a device people unplug.
- **DK-08 Something new wakes the screen.** In the day a new ask brightens a dimmed screen, draws an amber edge and plays
  one soft sound if there are speakers. Untouched for 10 minutes the screen dims (as CG-24); a paired screen never goes
  to sleep in the day. *Why:* the point of a desk screen is noticing.
- **DK-09 Quiet hours (mockup 4).** Default 23:00–07:00 in the person's time zone, on: the screen shows a dim clock (or, if
  chosen, goes black with the backlight off), never wakes for asks and makes no sound; a touch shows it for a minute.
  *Why:* it sits in a room people sleep near.
- **DK-10 The battery is a UPS.** On a machine with a battery: plugged in, the battery is held at 80 % where the machine
  allows a limit (a battery at 100 % around the clock wears out); on battery, the screen says so with the time left and
  owners get one Chat message from their assistant (“The power is out. Whombat is running on its battery, about 3 h
  left.”), another when it's back (“The power is back.”) and one at 15 %; at 10 % the box shuts down cleanly. Whether it
  starts again by itself when the power returns depends on the machine; nothing promises it. *Why:* a laptop on a desk
  rides out most power cuts, and a clean shutdown keeps the data safe in the others.
- **DK-11 A laptop that behaves like an appliance.** Closing a lid or folding the keyboard cover never suspends it; a
  short press on the power button only wakes the screen, holding it shuts down. A panel that reports itself taller than
  wide is turned to landscape. The screen draws with the graphics chip when the machine has a real one (motion and the
  wombats' idle back on; VMs keep software rendering). A USB-C Ethernet adapter works as the wired network (as today).
- **DK-12 How it is built.** The console stays without network (CG-03): the runtime opens a desk socket only the console
  server can use (`/run/whombat/console/desk.sock`, its peer checked) and is the one authority for what may show and what
  may be done; the console server checks every answer as it checks the console file today. Speech runs in its own
  service (`whombat-voice`, no network, models in the image). Battery state comes from the manager's host metrics.
  Settings are owners' session ops (`desk.*`), feature `desk`. *Why:* the console's trust model (CG-03, CG-08) moves as
  little as possible: it shows what Whombat chose to give it and passes on a few typed requests.
- **DK-13 Copy.** Short, plain words like the mockups; the assistant speaks in the first person (“I’m updating your
  server agents”); no ids, paths or commands except the command an ask is about.

## Not now

- **DK-14 No disk encryption on self-installed machines, desk machines included.** A self-installed box (bare metal
  too) keeps `host-encrypted` storage without a disk key (appliance PI-18…PI-21, PI-19's no recovery key). John,
  2026-10-20, asked whether a portable desk machine such as the Z13 should get TPM-bound encryption with a recovery key:
  “Disk encryption is not needed.” *Why:* his decision; PI-19 stands.
- **DK-15** Answering an assistant's question in its own thread from the screen (an `ask` on the talk request), Wi-Fi
  setup on the screen, “Show on desk” from a laptop or phone, the keyboard light as a status lamp, waking
  on presence (camera), a wake word, more than one person per screen, starting by itself after a power cut.

## A screen that works at once (2026-10-20, later)

John, 2026-10-20: “When we install a Whombat appliance I want the appliance to detect if it has a real monitor and
automatically pair the monitor if it has one. We should be able to disable the monitor in the settings, but the default
should be that the monitor works immediately. When we see the dashboard on the monitor, it has nothing to show until we
add connections / servers, so in the meanwhile I would like to show stats of the Whombat device itself (CPU / Memory /
Diskspace / etc) until we have proper data to show.” I proposed the design below with a mockup (appliance
`docs/design/desk-display/new-box.html`); John: “Yes, implement this fully.” These amend DK-01, DK-02, DK-04 and
DK-S14. Build brief: `docs/implementation/desk-display/auto-pair.md`. Ids: DK-16…DK-25 here, DK-S27… (server), contracts
CT-538… (0.101.0), appliance MG-72…, CG-57…, NX-200…NX-209 (NX-189…NX-199 are kept for the platform-neutral branch),
app AP-3100…AP-3114 web, AP-3115…AP-3129 Android, candidate IN-324.

- **DK-16 A real screen is one that says what it is.** A DRM connector counts as a real screen when it reads
  `connected`, its card's driver isn't a virtual machine's (virtio, bochs, qxl, vmwgfx, vboxvideo, hyperv, cirrus, the
  firmware framebuffers simpledrm/efidrm/vesadrm) and it has an EDID (the identity a monitor reports: a valid base block)
  whose maker isn't a virtual display's (`RHT`, QEMU's, which Proxmox and Incus show: John's DEV box reads `connected`,
  maker `RHT`, “QEMU Monitor”). A laptop's own panel (eDP, LVDS, DSI) is *built in*. The EDID's monitor name (“DELL
  U2720Q”) is shown in Settings. Read at most once a minute, so a monitor plugged in later counts too. *Why:* every VM
  has a connected virtual display, so `connected` alone (DK-S14) can't tell a desk from a cupboard; a management VGA port
  with nothing on it has no EDID.
- **DK-17 The screen pairs itself.** When a real screen is connected, nobody is paired and the screen isn't turned off
  (DK-20), it pairs itself to the owner who claimed the box (their person in their oldest burrow with an assistant), as
  soon as that person has an assistant: the claim creates the account first, the first run its burrow and assistant, so
  the screen goes from the claim code to “Claimed!” to the glance. When the claimer is no longer an owner or is gone, it
  pairs to the oldest owner with an assistant. No letters: for a claim with the console code, the claim already proved
  someone was at that screen; for any claim the box is the owner's own, the locked view is *A summary* (no message words,
  DK-03) and acting still needs an unlock. The log says the screen paired itself (“The screen paired itself with
  {name}.”), not that the person did. *Why:* John: “the default should be that the monitor works immediately.”
- **DK-18 No PIN until one is chosen.** A screen that paired itself (or was turned on in Settings, DK-20) has no PIN.
  Locked, a touch shows “Unlock as {name}” with only *Confirm on your phone* and “Choose a PIN in Settings to unlock
  here.”; a PIN sent anyway is refused. Settings asks the paired person to choose one; from then on DK-04 holds as before.
  *Why:* a PIN typed on the screen itself could be set by anyone walking past; the phone proves who it is.
- **DK-19 One message.** Right after the screen paired itself, the person's assistant posts once in their DM: “I’m on
  this Whombat’s screen now. To unlock it by touch, choose a PIN in Settings → This Whombat → Screen. You can turn the
  screen off there too.” *Why:* it happened without them; they should know, and know where to change it.
- **DK-20 One switch: Show Whombat on this screen.** Settings → This Whombat → Screen starts with the switch (owners). It
  reads as chosen when an owner chose, else on exactly when a real screen is connected (so a VM's virtual display reads
  off, with “This looks like a virtual machine’s screen, so it stays off unless you turn it on.”). *Off* ends the pairing,
  the console shows the plain claimed screen and goes dark after 10 minutes (CG-36), and nothing pairs itself while off,
  through updates and replugging. *On* pairs the screen to the owner who switched it on, without letters or a PIN (DK-18),
  when any screen is connected (a VM's too: they asked). While it is on and nobody is paired (the person left, DK-S15),
  the screen pairs itself again by DK-17, on any connected screen when an owner chose on. The switch replaces *Unpair*:
  `desk.unpair` from older apps turns the screen off. *Pair to me instead* (the letters and a PIN, DK-02) stays for an
  owner who isn't the paired person. *Why:* one control people understand; an unpair that the screen undid a minute later
  would be a trick.
- **DK-21 Boxes from before.** On the update, a box whose last pairing was undone (a `desk.unpaired` after the last
  `desk.paired`, and no pairing now) counts as turned off; any other box follows DK-17, so a box with a real screen that
  nobody paired pairs itself once. A box paired by its letters keeps that pairing and its PIN. *Why:* someone who unpaired
  chose no screen; everyone else gets the default.
- **DK-22 The Whombat's own figures until there is something else.** While the glance has no servers and no home tiles,
  it shows *This Whombat* where they would be (mockup `new-box.html`): the processor and memory now with the last hour (a
  point a minute), the cores, memory used of total, storage free of the data disk with what Whombat and the agents use,
  the processor's temperature where the machine has a sensor (not in VMs), network down/up per second now, and how long
  it has been up. The first server or home tile takes its place. It shows locked in *A summary* and *Everything* (figures,
  no words from messages), not in *Only the time*. When the manager doesn't answer, there is no panel (the glance as
  before). The words are the runtime's; the console only draws them (DK-12). *Why:* John: “show stats of the Whombat
  device itself … until we have proper data to show.”
- **DK-23 A new box says it is ready.** With nothing that needs the person, nothing worked on, no servers and no tiles,
  the status line is “All fine. I’m ready when you are.” with “Connect a server or your home, and I’ll keep an eye on it
  here.” as its muted part, and the Needs you card stays as a calm “Nothing needs you.” · “When I need a decision, it
  shows here.” *Why:* an empty glance should look finished, not broken.
- **DK-24 The manager adds the temperature and uptime.** `HostNow.cpuTempC` (whole °C, the processor's sensor: hwmon
  `k10temp`, `coretemp`, `zenpower`, else a CPU thermal zone; absent when none) and `HostNow.uptimeS`, both optional.
  Tones: storage warn at 85 %, bad at 95 % (as the disk alerts, BS-09); processor and memory as the server cards;
  temperature warn at 80 °C, bad at 90 °C. *Why:* the manager already measures the box every 10 s (BS-*); the desk already
  asks it every 10 s for the battery.
- **DK-25 Not now:** choosing the PIN on the screen itself (after a phone unlock), the agents' computers on the panel,
  temperatures of disks or the graphics chip, a panel for a box that also has servers.

## A four-digit PIN, and staying unlocked while you're there (2026-10-20, later)

John, 2026-10-20: “Allow a four-digit PIN at the appliance monitor. Also, can we detect if the user is present? If
present, do not rearm the code, but just when the user is not present anymore, ask for the code again. I think maybe we
can detect it with the camera. Use the camera for this.” I proposed the design below; John: “Implement this fully”.
These amend DK-02, DK-04 and DK-15 (“waking on presence” stays not now: DK-35). Build brief:
`docs/implementation/desk-display/presence.md`. Ids: DK-26…DK-35 here, DK-S34… (server), contracts CT-590…CT-609
(0.103.0), appliance NX-280…NX-299, CG-130…CG-149, MG-120…MG-129, app AP-3300…AP-3324 web, AP-3325…AP-3349 Android,
candidate IN-327.

- **DK-26 A PIN of 4 to 6 digits.** Whoever chooses the PIN chooses its length (“Choose a PIN of 4 to 6 digits”). PINs
  chosen before stay as they are. Whombat stores the length with the PIN's hash, never the digits, and the screen gets
  it: the pad shows that many dots and unlocks at the last digit, as phones do. DK-04's waits stay. *Why:* John asked for
  four digits. The pad shows the length, which costs little: at DK-04's waits, trying all 10,000 four-digit PINs takes
  over a year, the person hears of it at the fifth wrong one, and risky asks never get buttons on the screen (DK-05).
- **DK-27 PINs that are too easy are refused.** One digit repeated (0000), a run up or down (1234, 4321, 7890, 0987: each
  digit one more or one less than the one before, 9 and 0 next to each other), a pair or three digits repeated (1212,
  6969, 123123): “That PIN is too easy to guess. Choose another.” Whombat refuses them (core `deskPinTooEasy`, error
  `easy_pin`); Settings says so before it sends anything. PINs chosen before stay. *Why:* nearly one person in five picks
  1234, 1111 or 0000 (DataGenetics' study of 3.4 million PINs), and DK-04 gives five tries before the first wait.
- **DK-28 Stay unlocked while you're here.** A switch in Settings → This Whombat → Screen, the paired person's, off until
  they turn it on, shown only where the box has a camera that works (the presence service says so, DK-31). When it is on
  and the screen is unlocked, the camera looks about twice a second for a face in front of the screen. Once it has seen
  one, the screen stays unlocked while it keeps seeing one, and locks 30 seconds after the last face or touch. Until it
  has seen a face (a camera that is covered or points elsewhere), and whenever the camera fails or the picture is too dark
  to find a face, DK-04's rule holds: 2 minutes after the last touch (or face). The screen is unlocked this way for at
  most 4 hours in a row; then it locks and asks for the PIN or the phone again. *Why:* John: “If present, do not rearm the
  code, but just when the user is not present anymore, ask for the code again.” Walking away locks the screen in 30 seconds
  instead of 2 minutes. A camera that saw nobody doesn't cut the 2 minutes short, and 4 hours caps an unlock that a
  photo or a passer-by could keep going.
- **DK-29 A face never unlocks.** It only keeps an unlock that a PIN or the phone made. A locked screen never looks.
  *Why:* face detection doesn't know whose face it is; keeping an unlock going is what a touch does already.
- **DK-30 The camera is on only while the screen is unlocked with the switch on.** Every lock (the lock button, the 30
  seconds, the 2 minutes, the 4 hours, the switch turned off, unpairing, the screen turned off, a runtime restart) turns
  the camera off within seconds, and the service turns it off by itself 6 seconds after Whombat last asked. Where the
  camera has a light, the light means exactly this. While the camera is on, the lock chip shows a small camera mark
  (“The camera is on while the screen is unlocked”), and while it sees someone the chip reads “Unlocked as {name} · stays
  unlocked while you’re here”. *Why:* a camera that watches a room nobody asked it to watch is the one people tape over.
- **DK-31 It detects; it doesn't recognize.** One small program on the box, `whombat-presence`, reads the camera, finds
  faces with YuNet (MIT, about 230 KB, a few milliseconds a picture on the processor) and tells Whombat only whether, and
  when, it last saw one. No picture is kept or sent, no face is stored or compared, and the program has no network and
  writes nothing to disk. The kiosk's browser keeps the camera blocked. *Why:* knowing that someone is there is all DK-28
  needs. Recognizing who would mean keeping face data on the box, which is biometric data (GDPR art. 9).
- **DK-32 Which camera.** A colour camera before an infrared one, a rear camera last. When the colour picture stays too
  dark to find a face, an infrared camera, if there is one that gives a picture. Settings names no camera; the hardware
  report (HD-03) lists them. *Why:* the Z13's front camera is a 5 MP colour camera with an infrared one (Windows Hello's);
  under Linux the infrared light often needs a vendor command to come on, so the colour camera is the one that works
  everywhere. The rear camera (OV13855, AMD ISP4) has no Linux driver yet.
- **DK-33 Built like the voice service.** A service of its own (`whombat-presence`, socket activated, 0660
  whombat-presence:whombat) that the runtime asks every 2 seconds while it wants the camera (`POST /v1/presence/watch`)
  and tells when it doesn't (`/stop`). The camera is held by a child program (`presence-watch`, C++ with the onnxruntime
  the voice already brings), which runs only while the camera is wanted, so when it exits the camera closes. *Why:* the
  voice service's trust model (DK-12): no network, the runtime is the one authority, and the camera's lifetime is a
  process's lifetime.
- **DK-34 Older parts.** A console from before 0.103 doesn't know the PIN's length and draws six dots, so a shorter PIN
  can't be typed there; a box gets the runtime and the console in one candidate (a host release), so that lasts only
  through the update. An app from before asks for six digits, and its PINs stay valid; a newer app talking to an older
  runtime gets that runtime's refusal of a shorter PIN, in its words. *Why:* every part keeps working with the others;
  nothing needs a version check.
- **DK-35 Not now:** unlocking by face (recognition), waking the screen when someone walks up (the camera would watch a
  locked screen), the infrared light's vendor commands, two cameras at once, presence from the phone over Bluetooth.
- **DK-36 The box speaks with Kokoro, not Piper** (John, 2026-10-20: “the voice is really bad”, then “Implement your
  suggestion”). Answers are said by Kokoro v1.0 (Apache-2.0, the voice af_heart, US English) through sherpa-onnx on the
  box's processor, at 24 kHz, every answer equally loud with a little headroom; nothing else about Talk changes (the
  same voice socket and contract). *Why:* Piper's public-domain voice was chosen for its licence and sounded robotic;
  Kokoro sounds far more natural, has a licence that allows selling it, and two sentences still take about a second on
  four cores (appliance nixos.md NX-291…NX-296). *Not now:* choosing the voice in Settings (the voice request names
  none: a contracts change; since built, DK-50), a GPU voice on machines that have one.

## One glance that fits what there is (2026-10-20, later)

John, 2026-10-20, after three layouts to choose from (Assistant for the desk, Servers for the rack, Home for a hall
wall; mockups `~/.cache/wb-tmp/mockups/desk-layouts/`): “I think we should do 1 only and make it dynamical, so it
adjusts on the content available.” These amend DK-03 and DK-22 (the glance's parts and This Whombat). Ids: DK-37…DK-43
here, DK-S40… (server), contracts 0.104.0 (CT-601…), appliance CG-135… (`console-gui.md`, the page).

- **DK-37 One glance, laid out by what there is.** There is no layout to choose: every screen shows the glance (the
  Assistant layout). Its top stays as it is: the top bar, the clock with the assistant's line, Needs you, and Working on
  and Done today when there is something in them. The space under that is shared by the servers, the home tiles and
  This Whombat, and each takes the form that fits the room left. What shows while locked is still the person's choice
  (DK-03); *Only the time* still shows only the clock. *Why:* John chose the one layout; a desk with two servers and
  one with eight should both look full and finished, not have empty rows or missing parts.
- **DK-38 What gets the room.** The servers first, then the tiles, each in at most two rows of four, then This
  Whombat. When not everything fits, the arrangement that leaves out the fewest servers and tiles wins; among those, the
  one where This Whombat is the panel (DK-39); among those, the one with fewer rows. Servers left out are counted under
  the servers (“+3 more”, as before); servers come worst first (DK-S08), so the ones left out are the calm ones. *Why:*
  your servers and your home are what the screen is for; the box itself is one more thing to watch, not the main one.
- **DK-39 This Whombat always shows, as a panel or a card.** Not only on a new box (DK-22): on every glance except *Only
  the time*. With room it is the panel under the servers and tiles, which keeps its rule of showing the hour's chart
  when tall enough and the figures in one row when not (CG-59). Without room for the panel it is a card like a
  server's, first among them: its name (“This Whombat”, the logo), how long it has been up, and the processor, the
  memory and the temperature (storage when the machine has no sensor, as in a VM). *Why:* John asked where the box's
  own figures had gone once he had servers (DK-25 had put “a panel for a box that also has servers” on Not now).
- **DK-40 Cards share their row.** A row of servers or tiles divides the screen's width among the cards in it: two
  servers are two wide cards, five are a row of three over a row of two. A card alone in its row takes half the width.
  *Why:* a row of four places with two cards in it looked unfinished; one card stretched across the whole screen reads
  as a banner, not a card.
- **DK-41 Up to eight servers and eight tiles.** Whombat gives the screen up to eight of each (it gave four); the
  screen shows as many as fit (DK-38). Tiles beyond eight are left out without a count, as before beyond four.
  *Why:* a screen with little else on it has room for a second row.
- **DK-42 Older parts.** The new parts travel beside the old ones: the first four servers and tiles where they always
  were, the next four and This Whombat beside a glance with servers or tiles in new members. A console from before
  0.104 ignores them and shows the glance as before; a console from 0.104 on a runtime from before shows This Whombat
  only on a new box, as before. *Why:* the runtime and the console are updated separately (a runtime-only release can
  come first); neither may show a broken screen in between, and nothing needs a version check (as DK-34).
- **DK-43 Not now:** layouts to choose from (Servers, Home: John chose one), a chart per server (the fleet has 24 hours
  of each server's processor; a later step), the weather, an upright screen on a wall, a smaller server card for a
  crowded screen, choosing which tiles show and in which order on the screen itself.

## Choosing the screen's voice (2026-10-20, later)

John, 2026-10-20, after the box started speaking with Kokoro (DK-36): he wanted to choose the voice in Settings (“Yes I
want it”). These take DK-36's first *Not now*. Build brief: `docs/implementation/desk-voice/assignment.md`. Ids:
DK-50…DK-59 here, DK-S50… (server), contracts 0.105.0 (CT-610…CT-616), app AP-3400…AP-3449, appliance NX-300…NX-319.

- **DK-50 The person chooses the voice in Settings → This Whombat → Screen.** A *Voice* row under “Talk to
  {assistant}”: six voices, each with its name and kind — Heart and Bella (American, women), Michael and Fenrir
  (American, men), Emma (a British woman), George (a British man) — and one chosen, Heart until the paired person
  chooses another. Choosing saves at once, like the other Screen settings; only the paired person changes it, an owner
  who isn't sees it as the rest. The screen then answers in that voice. *Why:* John asked for it. These are Kokoro
  v1.0's best-rated voices of each kind, so there is a choice of accent and of a man's or a woman's voice without a
  long list to try; Heart is the voice the box spoke with before, so nothing changes until someone chooses.
- **DK-51 Listen plays a sample made by the box.** Each voice has a *Listen* button that plays, in the app, a short
  sentence said by the box in that voice: “Hi, I’m {assistant}. This is how I’ll sound on your desk.” (“Playing…” while
  it plays; “The voice couldn’t play. Try again.” when it can't). Listening changes nothing. *Why:* a name doesn't say
  how a voice sounds; the box makes the sample with the same voice service that answers, so what you hear is what the
  screen will say, and the sentence is Whombat's, so *Listen* can't be used to make the box say something else.
- **DK-52 A voice the box doesn't have is refused.** Whombat takes and plays only a voice the box's voice service says
  it has: another, or a sample when the box can't speak now, is refused with “That voice isn’t available on this
  Whombat.” A box whose voice service is older keeps speaking with its one voice, and Settings shows no Voice row
  there (nor where it can't speak at all). *Why:* the voice lives on the box, not in the database; an older voice
  service would refuse a request that names a voice, and a setting the box can't follow would look broken.
- **DK-53 Not now:** other languages, more voices than these six, a voice per person on a screen several people use
  (the screen is paired to one person, DK-02), a voice on the graphics chip of machines that have one.

## Asks that come to you, and Talk as a conversation (2026-10-20, later)

John, 2026-10-20: “At the appliance in desk mode, when the agents needs permission it should show a card on the screen
as a popup modal. Currently there is no way to approve or deny an approval because it's located in the chat in the WEB
UI. Regarding the chat on the appliance, I would like to be able to scroll through the messages, so the message should
stay on the screen.” What was there: the ask card opened only from a tapped Needs you row, over the glance only; in Talk
an approval showed as the answer's words without buttons (DK-T06); the card had Approve · Not now (a snooze, DK-S19) ·
Ask; Talk showed only the last question and answer, waited 90 s, and forgot both when the screen locked. I proposed
the design below; John answered: Deny and Not now both, “risky things require pincode”, “I'd like to see the chats as
sessions, so when I talk in a session this session keeps open until I close it or it times out”, and to build it
directly. These amend DK-05, DK-06 and DK-08. Ids: DK-60…DK-69 here, DK-S60… (`desk-display-server.md`), DK-T14…
(`desk-display-talk.md`), contracts 0.108.0 (CT-660…), appliance CG-190… (`console-gui.md`). No migration, no app
change.

- **DK-60 A new ask opens itself.** An ask that arrives while the screen shows (an approval or a question in Needs you)
  opens as a card over whatever is on the screen: the glance, the clock, Talk. Unlocked, it is the whole card; locked,
  the card without its words beside the PIN pad (or *Confirm on your phone*), and on a screen that shows no titles while
  locked (*A summary*, *Only the time*) the pad alone, saying what is waiting; after the unlock the card. Several come
  one at a time (“1 of 3”), the next once one is answered or closed. Closing it (Close, or a touch beside it) leaves the
  ask in Needs you, where a touch opens it as before. It waits while the person holds to talk and opens when they let go;
  never in quiet hours (DK-09: the ask waits in Needs you); a locked card nobody touches closes after 2 minutes, the
  amber edge stays. Only asks that are new to the screen open themselves, not those it finds when it starts. *Why:* John
  asked for “a card on the screen as a popup modal”; a card that opens over Talk is where the person is when the
  assistant asks while they talk to it.
- **DK-61 Approve · Deny · Not now.** An approval's card has Approve (in the ask's own words), Deny and Not now, and Ask
  while Talk is on. Deny is the person's no, decided as them as in Chat: the assistant hears it and goes on without it.
  Not now stays Home's snooze until tomorrow (DK-S19). A question keeps Answer · Not now. *Why:* John: there was “no way
  to approve or deny”; he wanted both a no and a later.
- **DK-62 Risky asks need the PIN.** The asks DK-05 kept on the phone (the Vault, money, deploying or main, deleting,
  keys, messaging outside: `deskMayDecide`) now have buttons on the screen too. Approve asks for the PIN again, even on an
  unlocked screen: the pad opens over the card (“Type your PIN to approve this.”) and the PIN goes with the decision,
  checked by Whombat as an unlock's (the same five tries and waits, the person hears of the fifth; the wait locks the
  screen). Deny and Not now need no PIN: neither does anything. On a screen without a PIN (DK-18) Approve stays on the
  phone (“Approve this on your phone.”); Deny and Not now work. *Why:* John: “risky things require pincode”. The PIN
  typed for this one decision proves the person is at the screen now, not only that someone unlocked it in the last
  minutes (or that a face kept it open, DK-28).
- **DK-63 Talk is a conversation.** Talk shows the conversation like a chat: the person's questions on the right, the
  assistant's messages on the left with its face, the newest at the bottom; swipe or scroll up to the earlier ones,
  the talk button and the keyboard stay at the bottom. A new message scrolls into view, unless the person scrolled up:
  then “New message” shows, a touch goes down. The assistant's whole message shows, made plain as it is said (DK-T06;
  code, tables, pictures and files stay in Chat: “There’s more of this in Chat.”), with the server it names under the
  answer to a question; a touch on an answer whose sound is still kept plays it again. An ask made in the conversation
  shows where it was asked, with what became of it (“Waiting for you”, “Approved”, “Denied”); a waiting one opens its
  card. An answer later than 90 s shows when it comes. After the person answers an ask the assistant made in the
  conversation, its next words are said, as an answer is. Locked, the conversation hides (message words, DK-03); after
  the unlock it is back as it was, after a kiosk restart too: Whombat keeps it, not the page. *Why:* John: “the message
  should stay on the screen (they can go off screen, but we have to be able to swipe / scroll to them again).”
- **DK-64 A conversation stays open until it is closed or times out.** The first question starts a conversation (a new
  Chat thread, as before). Every next question continues it, also after locking and unlocking and after *Back* to the
  glance, until the person closes it (*Close conversation* in Talk's top bar) or nothing was said in it for 30 minutes.
  Then Talk starts empty and the next question starts a new conversation. Ask on a card of an ask from another
  conversation starts a new one (as before); Ask on one asked in the open conversation goes back to it. A closed
  conversation stays in Chat like any thread. Unpairing ends it, and so does Whombat restarting (an update): the
  conversation is held in memory, the thread stays in Chat. Replaces DK-06's “a follow-up within 2 minutes continues
  it”. *Why:* John: “when I talk in a session this session keeps open until I close it or it times out.” 30 minutes is
  long enough to come back from a coffee and short enough that the next morning's question doesn't land in yesterday's
  thread.
- **DK-65 Older parts.** A console from before 0.108 shows the cards as before (no Deny, risky ones on the phone), Talk
  as before (its follow-up within 2 minutes now continues the open conversation, a later question starts a new one) and
  asks open only from Needs you. A console from 0.108 on an older runtime gets no Deny and no PIN to approve (the runtime
  doesn't offer them on the ask) and no conversation from Whombat: Talk then shows its own last question and answer.
  *Why:* the runtime and the console are updated separately (DK-42); nothing needs a version check.
- **DK-66 Not now:** answering a question in its own thread from the screen (DK-15 stays), a list of earlier
  conversations on the screen, speaking messages other than answers, pictures and files in the conversation, a voice
  “yes” to an ask.

## Only the clock when nobody's there, the camera to see who is, and staying unlocked (2026-10-20, evening)

John, 2026-10-20: “When the desk appliance is idle it should only show a big clock … it should use the camera to detect
presence.” I proposed the design below; John: “Build it. I don't know if the camera works on Z13 yet though. I also want
the option to keep the device unlocked after a single unlock.” These amend DK-04, DK-08, DK-28 and DK-30 and take DK-35's
“waking the screen when someone walks up”. Build brief: `docs/implementation/desk-display/idle-clock.md`. Ids:
DK-70…DK-79 here, DK-S70… (server), contracts 0.107.0 (CT-640…CT-659), appliance CG-170…CG-189 (`console-gui.md`), app
AP-3600…AP-3624 web, AP-3625…AP-3649 Android, migration 0126.

- **DK-70 Nobody there: only the clock.** By day a paired screen that nobody is using shows the time alone, very large,
  with the date small under it: no top bar, chips, status line, servers or tiles. Two things stay: the power-cut banner
  (DK-10), and, while something needs the person (an ask, or a server that is down: the night line's rule), a small
  amber dot under the date (“Something needs you.” for screen readers). A touch, a key or someone in front of the camera
  (DK-72) brings the glance back; the first touch only wakes, as on the dimmed and night screens. The clock moves a few
  pixels every minute (CG-09) and isn't dimmed. This replaces DK-08's dimming after 10 minutes; quiet hours (DK-09) stay
  as they are. *Why:* John asked for it. A screen on a desk that nobody looks at is a clock; the glance is for when
  someone looks.
- **DK-71 When the screen is idle.** Without the camera: 10 minutes after the last touch (DK-08's time). With the
  camera watching (DK-72): a minute after the last face and the last touch, whichever is later. When the camera can't
  tell (starting, too dark, failed), the 10 minutes hold. A new ask by day still wakes the glance with the amber edge and
  one sound (DK-08) and keeps it up for 10 minutes even when nobody is seen; then the clock with the dot. Never idle
  while the pairing letters show, the phone is asked to unlock, or Talk is listening, thinking or speaking. A PIN pad or
  an ask left open closes when the screen goes idle, and so does a Talk that has finished. *Why:* with a camera the
  screen knows when someone left, so a minute is enough; without one, the 10 minutes are the guess they were before.
  The ask is what the screen is for.
- **DK-72 Use the camera to see when you're here.** A switch in Settings → This Whombat → Screen, the paired person's,
  off until they turn it on, shown only where the camera works (as DK-28's). On, the camera looks about twice a second
  while the screen is on outside quiet hours, locked or unlocked; the screen shows the glance while it sees a face and
  goes back to the clock a minute after the last one (DK-71). It is off in quiet hours, on battery, while the screen is
  turned off or unpaired, and while the console isn't showing the desk. A face still never unlocks (DK-29): a locked
  screen shows the locked glance, exactly what a touch would show (DK-03's choice). *Why:* John asked for the camera.
  Looking while locked is what DK-30 ruled out, so it is a switch of its own: turning it on is choosing a camera that is
  on all day, which is more than DK-28's camera while unlocked. The light (where the camera has one) stays on all that
  time; switching the camera on and off to save it would make waking slow and the light harder to trust. No camera at
  night: the dim clock doesn't need one.
- **DK-73 The camera says so.** While the camera is on for DK-72, the glance's top bar shows the camera mark (“The camera
  is on to see when you’re here”) and the clock shows the same mark, small, in a corner. The detector, the service and
  what they keep are DK-31's and DK-33's: nothing is stored or sent. *Why:* DK-30's rule: a camera that is on is never a
  secret, also when the clock is all there is.
- **DK-74 Lock again: after 2 minutes, when you leave, or when you press Lock.** Settings → This Whombat → Screen's
  camera switch *Stay unlocked while you’re here* (DK-28) becomes a choice, *Lock again*: **After 2 minutes** (the
  default, DK-04), **When you leave** (DK-28, only where the camera works) and **When you press Lock**, the paired
  person's. With the last, an unlock by PIN or phone lasts until the Lock button, another choice, the screen turned off,
  unpaired or paired again, or a reboot (DK-75); the 4 hours of DK-28 don't apply. The choice applies at once, to an
  unlock that is going on too: from *When you press Lock* back to *After 2 minutes*, the screen locks 2 minutes later
  (the change counts as a touch), not at once. The lock chip says “Unlocked as {name}” without minutes. Its hint says what it means:
  anyone at the screen can see what it shows, answer everyday asks and talk to the assistant as the person. Asks that
  stay on the phone stay there (DK-05). *Why:* John: “I also want the option to keep the device unlocked after a single
  unlock.” DK-05 keeps what can't be undone off the screen either way; one choice with three answers reads better than
  two switches that both say “stay unlocked”.
- **DK-75 An update keeps the unlock; a reboot doesn't.** With *When you press Lock*, Whombat writes the machine's boot
  id with the unlock, and a runtime that starts on the same boot with the choice still made is unlocked again. A reboot
  or power cut, the database restored on another machine, a machine that has no boot id, and every lock clear it. *Why:*
  the runtime restarts with every update, several times a day on DEV; unlocking after each would make the choice
  useless. A reboot is when the box may have been carried off, so it asks again, as a laptop does.
- **DK-76 Older parts.** The runtime and the console arrive in one candidate (a host release), as for DK-34. A console
  from before 0.107 ignores the camera's new member and the lock's `stays`: it shows the glance and dims as before, and a
  screen that stays unlocked reads “locks in 2 min” there. An app from before shows *Stay unlocked while you’re here* and
  no new rows; on a screen set to *When you press Lock*, that choice wins over its switch. A newer app on an older
  runtime shows the switch as before (the runtime lists no choices). *Why:* every part keeps working with the others,
  and nothing needs a version check.
- **DK-77 Not now:** keeping the glance up all day without a camera (a wall display), a choice of clock (analogue,
  seconds, the weather), dimming the clock by the room's light, waking when the person's phone is near, choosing the
  idle times, a reboot that keeps the unlock.

## Server cards three to a row, and a server's own screen (2026-10-21)

John, 2026-10-21 (main checkout), with a picture of three figures on their own lines (`CPU`, `MEM`, `DISK`, each a bar
and its percentage): “The Whombat desk appliance (screen) should show the server overview on the dashboard as cards (3
next to each other) where we show the Name of the server, with the OS icon in front of it, below that we show the CPU,
Memory and Disk usage like this (but on the blocked design we currently already use for the bar). When we click on the
card we should be presented with a full screen dashboard with stats of the server.” I proposed the design below with two
mockups (appliance `docs/design/desk-servers/`, frame 1 the glance, frame 2 a server's screen); John: “Implement this
fully.” These amend DK-03 (what a card shows), DK-38, DK-40 and DK-41 (the servers' rows) and DK-39 (This Whombat's
card), and take “a chart per server” off DK-43's Not now. Ids: DK-80…DK-89 here, DK-S80… (`desk-display-server.md`),
contracts 0.115.0 (CT-860…CT-879), appliance CG-250…CG-279 (`console-gui.md`), candidate 0.131.0. Build brief:
`docs/implementation/desk-display/server-cards.md`.

- **DK-80 A server card: its name, then CPU, memory and disk on lines of their own.** The card's head stays: the OS mark,
  the name and the note on the right (“up 41 d”, “updating”). Under it three lines, each a short label (CPU, MEM, DISK),
  the glance's block bar (20 blocks now that the bar is long) and the percentage. Processor and memory keep the colours
  the cards had; disk takes This Whombat's storage colours. The temperature leaves the card for the server's own screen
  (DK-83). *Why:* John's picture; the disk fills up slowly and is noticed too late, and three lines read faster than
  three columns.
- **DK-81 A hot server says so.** With the temperature off the card, a server whose hottest sensor is warm or hot (the
  card's old temperature colours: 15° under its limit, at its limit) says it in its note, “hot · 84°”, and turns amber
  or red like any server that needs a look, sorting with them (worst first, DK-S08). An off server, and a note that
  already says something is wrong, keep theirs. *Why:* nothing the card showed before may disappear without a trace.
- **DK-82 Three to a row, up to three rows.** Servers sit three to a row (they sat four). Every card is a third of the
  width, in a short row too, so the bars line up from row to row; rows fill from the left. Up to three rows: This
  Whombat's card and the eight servers of DK-41 fit exactly when no tiles need the room. The rest of DK-38 stands:
  servers first, then the tiles (four to a row, DK-40 still holds for them), then This Whombat as the panel or a card;
  servers left out are counted (“+3 more”). *Why:* John asked for three next to each other; a card a third wide has room
  for a bar long enough to read, and bars that line up compare at a glance.
- **DK-83 Touch a server and it fills the screen.** Touching a card opens the server's own screen (mockup 2), to look
  at. At the top: back, the OS mark, the name, the OS with its cores and uptime, its state (“All fine”, or the note) and
  the lock chip. Four figures, each big with its block bar: CPU (with the load), memory (used, of the total), disk (used
  of the total) and temperature (cool, warm or hot, and the limit). A chart of CPU and memory over the last hour, 24
  hours or 7 days (24 hours first), with CPU's peak and memory's average. Storage per volume (up to six), the guests
  (how many run and how many are off; up to six, busiest first, with their CPU and memory) and the network now. Swiping
  left or right, or the dots, goes to the next or previous server in the order it was opened from. Back, or two minutes
  untouched, returns to the glance; the idle clock comes as before (DK-70). The figures refresh every 10 seconds while
  it shows. *Why:* John asked for a full-screen dashboard; the This Whombat panel already has this look (chart,
  figures, block bars), so a server gets the same.
- **DK-84 Locked, a server's screen shows; it still doesn't act.** It opens on a locked screen too (*A summary* and
  *Everything*), because the card shows the same kind of figures; touching a card on a locked glance opens the server,
  not the PIN pad. Its open alerts are counted while locked; their titles show only unlocked or with *Everything*
  (DK-03: words stay off a locked screen unless the person chose them). *Only the time* has no cards and so no server
  screen; a screen that locks into *Only the time* goes back. Nothing on it changes the server: no restart, no stop.
  *Why:* DK-03 and DK-05; changing a server goes through the assistant, which asks the person where DK-05 says.
- **DK-85 Ask about this server.** The screen ends with “Ask {assistant} about {server}”. It opens Talk (after the PIN
  when locked, DK-04) with the server named: Whombat tells the assistant which server the person was looking at (an
  instruction to the assistant, never words in the chat), and the answer shows that server (DK-06). *Why:* the quickest
  way from “that looks high” to “why is pve-01 busy?”.
- **DK-86 All the servers.** “+N more” under the servers is a button. It opens *Servers*: every server as the same
  cards, three to a row, worst first (up to 24, the rest counted). Touching one opens its screen; swiping there goes
  through this list. *Why:* a desk with more servers than fit shouldn't hide them.
- **DK-87 This Whombat opens too.** Its card has the same three lines as a server's (CPU, MEM, DISK: the data disk), and
  touching the card or the panel opens its own screen: the This Whombat panel at full size, with back. *Why:* one way
  of looking at every machine on the glance.
- **DK-88 Older parts.** The new members are optional (as DK-42): a console from before 0.115 ignores them and draws the
  cards as before (a hot server's note shows there too). A new console on an older runtime gets no server id (the
  cards don't open and “+N more” is no button) and no disk (the DISK line shows “–”). The runtime and the console
  arrive in one candidate. *Why:* every part keeps working with the others, and nothing needs a version check.
- **DK-89 Not now:** changing a server from its screen (restart, updates, a guest's power), a guest's own screen,
  choosing which figures a card shows, a temperature chart, server cards on the phone's Home, an upright screen.

## A calmer glance: one Needs you, the assistant only when it needs you, dimmed when nobody's there (2026-10-21)

John, 2026-10-21 evening (main checkout): “At the screen of my desk appliance I want to make a couple of changes: 1) Add
more spacing between the digits and the “:” in the clock. 2) Remove the “Services” from the dashboard. 3) Align the
server cards at the bottom of the screen, so there is more room between the clock / needs you and the server cards. 4)
We have an agent saying “Home Assistant needs a look.”, but the “Needs you” card is empty. This is weird and I think we
only should use “Needs you” card. 5) Use the Whombat agent only if there is a question / action that the user needs to
take, make sure we can click on it and see what the issue is and can act on it with the agent. 6) Remove the clock when
there is a time-out, but instead dim the screen so we keep the Servers cards and clock visible.” Asked which part
“Services” is, he chose the home tiles row. These amend DK-03 (the assistant's line), DK-38…DK-41 (no tiles), DK-70
(the idle clock) and DK-73 (its camera mark). Ids: DK-90…DK-99 here, DK-S110… (`desk-display-server.md`), contracts
0.118.0 (CT-970…CT-989), appliance CG-310…CG-329 (`console-gui.md`).

- **DK-90 The clock's colon stands apart.** In the glance's clock, *Only the time*'s and the night's, the colon has a
  little room on both sides (about a tenth of a digit's width), the digits keep CG-171's tight spacing. *Why:* John's
  point 1: the tabular digits nearly touched the colon.
- **DK-91 No home tiles on the glance.** The glance no longer shows the home tiles (a figure from a connection, a device
  or a Home widget: “21.4 °C Living room”); their room goes to the servers, Found on your network and This Whombat.
  Whombat keeps sending `tiles` (an older console still draws them); the screen ignores them. This Whombat still takes
  the servers' place on a glance without servers (as a panel when it fits, DK-39). *Why:* John's point 2. The things
  behind the tiles still reach the screen when they need a look (DK-93).
- **DK-92 The cards sit at the bottom.** The room under the clock and Needs you keeps what it holds at its bottom edge
  (the server cards, “+N more”, Found on your network, This Whombat), so the space left over is between the top part
  and the cards. *Why:* John's point 3.
- **DK-93 Needs you lists what needs a look too.** Besides the asks, Needs you holds the servers, connections and
  devices that are down or need a look: the same statuses that colour a server card and the sidebar's dots, each “{name}
  is down.” or “{name} needs a look.” with the reason Whombat knows (“2 integrations not loading”, “Filling up”). Down
  first, then the asks, then the others; the count is all of them; at most five looks. A look doesn't wake the screen or
  chime (DK-08 stays for asks). Locked, the looks show in *A summary* and *Everything* (the cards already show these
  names and colours), never in *Only the time*. *Why:* John's point 4: the assistant said something needed a look
  while Needs you said nothing did.
- **DK-94 The assistant speaks only when something needs you.** Its line under the clock (its face and words) shows
  only while Needs you has something, and says the first thing in it: a look's “Home Assistant needs a look.” with
  “Shall I look into it?”, an ask's “{title} needs a decision.” with “Touch to answer.”, and locked without titles “2
  things need you.” The line is a button that opens that first thing. When nothing needs you there is no line:
  “Everything’s fine. I’m …” is gone (Working on shows the work). A new box still says what it found (DF-09). *Why:*
  John's point 5.
- **DK-95 A look's card.** Touching a look (its row in Needs you or the assistant's line) opens a card like an ask's
  (DK-05): the assistant's face with “{assistant} noticed” and what it is (a server, a connection, a device), the title,
  the reason (else “I don’t know why yet.”), and the buttons *Ask {assistant} to fix it*, *Open {name}* for a server
  (its screen, DK-83) and *Close*. It opens locked too; asking the assistant then asks for the PIN first (DK-04). A thing
  that is fine again while its card is open says “It looks fine again.” and keeps only *Close*. *Why:* John's point 5:
  “see what the issue is and can act on it with the agent”.
- **Superseded in part by look-research.md LR-08, LR-09** (a look the assistant looked into offers its step and *Ask {assistant}*). **DK-96 Ask to fix it.** *Ask {assistant} to fix it* opens Talk on a new conversation and sends, as the person's own
  typed words, “Please take a look at {name}: {reason}.” (without a reason “Please take a look at {name}.”); for a
  server Whombat also tells the assistant which server it is (DK-85). From there it is any question: the assistant's
  asks come to the screen (DK-60) and its answer is said (DK-06). While Talk still waits for an earlier answer, the words
  wait in Talk's box. *Why:* one touch from “something's wrong” to the assistant working on it, in words a person would
  type.
- **DK-97 Nobody there: the glance, dimmed.** When nobody's there (DK-70, DK-71: 10 minutes untouched, or a minute
  after the camera last saw someone) the screen keeps the glance and dims it (a dark layer, about 40 % bright as CG-09's
  dim) and moves it a few pixels a minute (CG-09's drift), instead of the big clock: the time, Needs you and the server
  cards stay readable from across the desk. The rest of DK-70…DK-73 stands: the first touch only wakes it, a new ask, a
  key or a face wakes it, the camera's mark is the lock chip's. *Why:* John's point 6.
- **DK-98 Older parts.** `needsYou.looks` is optional: an older console ignores it (its line still says “Home Assistant
  needs a look.”); a new console on an older runtime gets no looks, so Needs you holds the asks only and the line shows
  only for them. The runtime and the console arrive in one candidate.
- **DK-99 Not now:** Home's other Needs you items on the screen (an open server alert, “Reconnect Google”; the server's
  or connection's own look covers most of them), *Not now* for a look, the backlight going down by day, looks on the
  phone's Home.

## This Whombat only on a new box (2026-10-22)

John, 2026-10-22 (main checkout): “At the desk appliance screen when there is ‘Nothing to do’ the ‘This Whombat’ card
shows up. I only want to see this card when nothing is configured, meaning no servers are being displayed, meaning after
a fresh installation only.” This amends DK-39 (and DK-91's last sentence stands). Ids: DK-100…

- **DK-100 This Whombat only while there are no servers.** The glance shows This Whombat (the panel, or its card when
  the panel doesn't fit) only while it has no servers, as on a new box (DK-22); the first server takes its place, as
  before DK-39. Found on your network still takes its place on a glance without servers (DF-06). The runtime decides:
  `box` without servers and tiles, `self` without servers beside tiles (which the screen no longer draws, DK-91), and
  neither beside servers, so a console from 0.104 on draws it right without a new release; the manager isn't asked for
  the box's figures while servers show. With servers there is no way to its own screen (DK-87) on the desk; Settings →
  This Whombat → How it’s doing shows the same figures. *Why:* John wants the box's own figures only after a fresh
  installation; once servers show, the glance is theirs (DK-38: the box is one more thing to watch, not the main one).

## The calm glance and Settings → Screen (2026-10-27)

John, 2026-10-27 (main checkout): not satisfied with the glance (“we currently have a static dashboard, but we could
make it more dynamic by only showing what's relevant at the moment? Or change the way the servers are being
displayed?”; the box sits on the desk, glanced at now and then and lightly touched). After my critique (an inventory
rather than an answer: eight server cards with 24 bars fill two thirds of the screen to say “12 %”, a problem is a
thin border, the assistant's line repeats Needs you) and mockups (appliance `docs/design/desk-calm/`), he chose the
calm glance, asked to keep a top bar (battery, connection, remote help, …), to let the person decide what's important
in a Settings tab of its own, and: “Implement this fully and use the Whombat's name on the left of the topbar.” These
replace DK-03's parts of the glance, DK-38…DK-41, DK-80…DK-82 and DK-92…DK-94 for a console that knows the calm glance;
the rest stands. Ids: DK-101…DK-125 here, DK-S120… (`desk-display-server.md`), contracts 3.2.0 (CT-1620…CT-1649),
appliance CG-350…CG-399 (`console-gui.md`), app AP-5830…AP-5879 (`docs/app/decisions/desk-display-web.md`,
`desk-display-android.md`).

- **DK-101 One frame, changing content.** The glance is a fixed frame whose parts stay where they are while what's in
  them changes: the top bar about the box; the clock with one sentence about how things are; the middle for what
  matters now; the servers in a strip along the bottom. Nothing rotates, nothing moves place; a change animates once to
  catch the eye and then rests. *Why:* a two-second glance needs the answer where it was last time; carousels hide it.
- **DK-102 The person chooses what shows.** The choices live with the screen's settings (`DeskSettings.show`): the top
  bar's items, each thing's level, the strip's order, the clock, *Welcome back* and *Done today*. `desk.update` takes
  any part (`show`), Settings shows the change before the answer.
- **DK-103 One choice for everything: Always · When it matters · Off.** *Always* pins it (a card in the middle, a server
  in the strip, a chip in the top bar), *When it matters* shows it only while something is going on with it or wrong
  with it, *Off* never. *Why:* one idea to learn, everywhere.
- **DK-104 Off means off on the screen.** A thing set to *Off* never shows on the screen, its problems neither; they
  still reach the phone and Home as before. Questions from the assistant always reach the screen; remote help and the
  camera always show while on (DK-111). *Why:* backup-box is usually off; the screen shouldn't keep saying so.
- **DK-105 Defaults that need no setup.** Servers *Always* (the strip shows them all), Home's widgets *Off* (DK-91),
  everything else *When it matters*; the top bar's network, internet and battery *Always*, updates *When it matters*;
  the clock big; *Welcome back* and *Done today* on.
- **DK-106 What can be chosen.** Settings lists (`DeskScreen.showOptions`): the assistant's work and what's coming up;
  the connections and devices (with what their *When it matters* shows, “Who’s watching”); Home's widgets; the servers
  in the strip's order; This Whombat.
- **DK-107 The clock.** Big while nothing needs the person (the person may choose small), small whenever something
  does: the hero takes the room.
- **DK-108 The strip's order.** The person's order first (dragged in Settings), then the rest worst first, then by
  name.
- **DK-109 Done today.** **Superseded in part by done-today.md DN-03**: what it counts and lists are the tasks the
  assistant finished, in its own words. “{assistant} did 3 things today ›” at the right of the middle's label; touching
  it lists them. Off in Settings, it's gone.
- **DK-110 The top bar.** Left the Whombat's name (DK-119); right, quiet grey chips with a word each and colour only
  when something's off: the network (the Wi-Fi's name or *Cable*; *No network* in amber), the internet (*Online*; *No
  internet* in amber), remote help, *Updating* while Whombat updates itself, the battery (its charge; *On battery ·
  2 h 40 min* in amber; *9 % · plug me in* in red), the camera's mark and the lock. *When it matters* keeps a chip out
  until its state is off. Touching the bar opens one sheet with the details (Wi-Fi, battery, remote help, updates)
  and the sheets the chips opened before. *Why:* John asked to keep the top bar with battery, connection and remote.
- **DK-111 What can't be hidden.** Remote help shows while it's on (*Remote help on*), and as a lit pill while someone
  is connected (*Support is connected*), touching it opens its sheet with *Stop*; the camera's mark shows while it
  looks. *Why:* the person must always know.
- **DK-112 The sentence by the clock.** One sentence in one colour, readable from the chair: *All fine* (green) with
  “8 servers and 14 services are running. Nothing needs you.”; *{assistant} is busy* (sand) with the work and “2 of 4
  done.”; *1 thing to look at* (amber); *1 thing is wrong* or *{assistant} has a question* (red). The assistant's line
  under the clock (DK-94) goes: the hero says it.
- **Superseded in part by look-research.md LR-09, LR-10** (a looked-into look's words and buttons; *Ignore* for *Not now*). **DK-113 The hero.** When something needs the person, the first of it takes the middle, big: a server or connection
  that is down, then the questions and approvals, then what's in trouble, then what to look at. It says what and since
  when (“pve-02 isn’t answering · Since 14:30 · 4 min”) and what it means (“Plex, Home Assistant and 2 more run on it,
  so they’re down too.”), with the action on it: *Ask {assistant} to fix it* (DK-96), *Open {name}* (DK-83) and *Not
  now* for a look; *Answer* (the ask's card, DK-60) for an ask. A thin coloured edge along the top of the screen
  catches the eye from the side.
- **DK-114 Also.** Up to two more things wait on a line each under the hero, and “+N more” counts the rest; touching one
  opens its card. A filling disk says its forecast: “disk is 88 % full; at this rate it’s full in about 12 days”.
- **DK-115 The middle when nothing needs you.** Up to three cards of what's going on: the person's *Always* things
  first, then the assistant's work, connections with something going on (Plex's viewers, the download queue with its
  bar, new requests) and what's coming up within two hours. Nothing going on: the middle stays empty.
- **DK-116 The strip.** Every server the person shows, at most eight, as a small chip: its mark and name, a line of its
  last hour's processor while fine, a few words in colour when not (“not answering”, “disk 88 %”, “updating”); *Off*
  ones dim. “+N” opens *Servers* (DK-86). Touching a chip opens its screen (DK-83). *Why:* the cards' 24 bars said
  “fine” at length; the strip says it in a row and says the exception in words.
- **DK-117 Work shows on what it touches.** While the assistant's work goes through servers (a step named like one),
  their chips say done, now, next: no separate *Working on* panel to match against the cards.
- **DK-118 Whombat updating itself.** While the manager installs or restarts into a release, the top bar says so
  (*Updating*; *When it matters* by default shows it only then).
- **DK-119 The Whombat's name on the left.** The top bar's name is the Whombat's (“Home”), not the org's. The box
  doesn't know it — control's directory has it — so the app gives it (`desk.setName`) whenever it knows a different
  one: when Settings → Screen or This Whombat opens, and after Rename. Until then the org's name. *Why:* John's choice.
- **DK-120 Welcome back.** When someone comes back after at least 30 minutes away (the camera sees a face, or the first
  touch), the screen starts with “Welcome back.”, how long, and up to five lines of what happened: a question waiting
  (first, with *Answer*), what the assistant finished, what went down, came back or got worse. Off in Settings, it
  doesn't. Nothing happened: no Welcome back.
- **DK-121 Welcome back goes.** After a minute, or a touch, back to the glance; shown once.
- **DK-122 What the lock lets show.** *Only the time*: the sentence and the clock only. *A summary*: no ask's title (the
  hero says “{assistant} has a question”), no card's detail, Welcome back as counts. *Everything* and unlocked: all.
- **DK-123 Settings → Screen.** A tab of its own between Connections and This Whombat, only on a Whombat with a screen:
  the switch *Show Whombat on this screen* and the screen line on top, then four parts — *What it shows* (new), *Lock and
  PIN*, *Night* and *Talk* (the rows that were This Whombat → SCREEN). *What it shows* has the preview, *Top bar*, *The
  middle*, *Servers* (drag, or Move up/down) and *Around it* (clock, Welcome back, Done today). This Whombat keeps one
  line that opens the tab. The phone has the same page. The preview is the box's own calm glance for the choices on the
  page (saved or not), for *Now*, *Something’s wrong* or *{assistant} at work* (`desk.preview`); on a wide window it
  stays in view beside the choices.
- **DK-124 Try it on the screen.** From the preview, the screen itself shows the chosen scenario for a minute with a
  banner “Preview from Settings” (`desk.tryOnScreen`); a touch ends it.
- **DK-125 Older parts.** `DeskGlance.calm` and `DeskState.name` are optional: an older console draws the glance it
  knows from the members beside them, which the runtime keeps filling; a new console on an older runtime gets no
  `calm` and draws the old glance. Settings shows *What it shows* only where `DeskScreen.showOptions` is there.

## Screens of widgets (2026-10-27, later)

John, 2026-10-27 (main checkout): “I want to redesign the screen of a Whombat appliance. I want to create widgets that we
can add on a screen via the WEB UI in a grid … for all kinds of servers and services. The Screen tab should make it
simple to add widgets to the screen (drag and drop / edit widget).” Then: problems and the assistant's questions as a
modal, the whole dashboard configurable but not the top bar, a grid that isn't fixed (many laptop screens and monitors),
external screens later (monitors, tablets); a modal only for outages and questions (yes), pages (“would be nice”); after
the mockups (`~/.cache/wb-tmp/mockups/desk-widgets/`, committed in appliance `docs/design/desk-widgets/`): “Implement
this fully, use your best judgement for the decisions.” These replace DK-101 (one fixed frame), DK-107 (the clock as
part of the frame), DK-113…DK-117 (the hero, the middle and the strip as fixed parts) and DK-123 (*What it shows*) for a
screen that knows the grid; DK-102…DK-106 stay as the choices of the *What’s going on* and *Servers* widgets; DK-110,
DK-111, DK-118…DK-122 stay. Ids: DK-126…DK-159 here (DK-150 after DK-148), DK-S160… (`desk-display-server.md`), web AP-5940…AP-5999
(`docs/app/decisions/desk-display-web.md`), phone AP-6000…AP-6039 (`desk-display-android.md`), appliance CG-380…
(`console-gui.md`), contracts 3.6.0. Build brief: `docs/implementation/desk-display/widgets.md`.

- **DK-126 A screen is a grid of widgets the person arranges.** Under the top bar everything is a widget: placed,
  moved, resized and removed by the person. *Why:* John asked for it; one idea for every screen.
- **DK-127 The calm glance is the default layout.** A screen nobody arranged shows *Clock*, *How things are*, *What’s
  going on* and *Servers*, laid out as the calm glance was; nothing to set up. The calm planner (`deskCalmFor`) keeps
  deciding what those widgets say, and what the modal and the pill show.
- **DK-128 Screens, not one screen.** The box's own display, a monitor plugged into the box and a tablet or computer
  elsewhere are each a screen with its own name, layout, pages, Size, page turning and pop-ups. Settings → Screen
  becomes *Settings → Screens*: every screen, and *Add a screen*. *Why:* John wants monitors and tablets; designing for
  one screen would have to be undone.
- **DK-129 The grid comes from the screen.** Cells of about 140 logical pixels, as many as fit under the top bar,
  stretched to fill: the Z13 8 × 5, a 24″ 1080p monitor 12 × 7, a portrait iPad 5 × 7. The screen tells the runtime
  its size; the grid's numbers come from `@whombat/screen`, the same everywhere. *Why:* screens differ.
- **DK-130 Size.** Per screen *Smaller · Normal · Larger* scales everything (0.8, 1, 1.3), so a screen across the room
  gets bigger widgets and fewer cells. Normal by default.
- **DK-131 Widgets resize freely, each between its own smallest and largest size, and draw a designed form for the room
  they get** (a figure; a figure and a line; a list; posters). *Why:* with screens of every shape, fixed sizes would
  leave gaps; designed forms keep every size looking intended.
- **DK-132 A layout per page and per shape.** A page keeps a layout for each grid shape it was arranged on. On a shape
  it has none for, the screen draws the latest one rearranged: what fits stays where it is, a widget as wide as the
  old grid stretches to the new width, the rest go to the first free spot in reading order, smaller if they must; what
  still doesn't fit isn't drawn and waits in the editor's *Didn’t fit*. Changing the rearranged one keeps it for that
  shape. Nothing is thrown away. *Why:* turning a tablet or changing Size must not undo the person's work.
- **DK-133 Pages.** Up to 6 pages per screen, each with a name. The top bar shows their names in the middle (dots on a
  narrow screen); swipe, or touch a name. Pages turn *When touched* (the default) or *Every 30 seconds* / *Every
  minute*, which waits while someone touches the screen. A screen that turns when touched goes back to its first page
  after 2 minutes untouched. *Why:* John: “pages would be nice”; a glance needs a known first page.
- **DK-134 The top bar is fixed.** Left the Whombat's name and, while something needs the person, the pill (DK-136);
  the middle the pages; right the box's chips as DK-110 (a screen elsewhere shows *Online* and the lock). Not part of
  the layout. *Why:* John: the whole dashboard configurable, not the top bar.
- **DK-135 Outages and questions open a modal.** A server or connection that is down, and the assistant's questions and
  approvals, open a modal over the dashboard, in the calm planner's order (down first, then questions, then the rest):
  what, since when, what it means, and its step (*Ask {assistant} to fix it*, *Open {name}*, the ask's answers), *Not
  now*, and “1 of 3” with arrows when there are more. A thin coloured edge along the top catches the eye from the side.
  It opens again only for something new and closes itself when what it shows is resolved. Smaller things (something to
  look at, a disk filling up) never open it. *Why:* John chose a modal, only for outages and questions.
- **DK-136 The pill.** *Superseded in part by needs-you-list.md NYL-14* (it counts what Needs you counts). While anything needs the person — what the modal shows and the smaller things — a pill beside the
  name says so (“2 things need you”, red for an outage or a question, amber otherwise); touching it opens the modal with
  everything, smaller things included. The widgets it touches say so in their own place (a red card, a red chip).
- **DK-137 Pop-ups per screen.** *Questions and problems* (the box's default), *Problems only* (a new screen
  elsewhere's), *Nothing*. A screen with *Nothing* still shows the pill. *Why:* questions can be private; a kitchen is
  for everyone.
- **DK-138 Locked.** The lock's choices (DK-122) hold for every screen: *Only the time* shows the clock alone, *A
  summary* shows the widgets but no ask's title (“{assistant} has a question”), no camera stills, no titles a widget
  marks private (what's playing, the calendar's appointments) unless the person chose to show them for that widget.
  Answering, a look's step and *Open* ask for the PIN first. A screen elsewhere is always locked in this way unless it
  was unlocked with the PIN; it locks again after 2 minutes untouched. Unlocked, it shows what *A summary* hides, but it
  never answers a question or takes a look's step: its modal says to answer on the phone or at the box. *Why:* a
  screen elsewhere is seen by more people; deciding stays with the person's devices and the box.
- **DK-139 What can be a widget.** Whombat's own: *Clock*, *How things are*, *What’s going on*, *Servers*, *{assistant}’s
  work*, *Coming up*, *Done today*. Each server: its processor, memory and disk, with a chart when wide. Each connection
  and device: its figures, and every panel of its page (*Now playing*, *Recently added*, the download queue, requests,
  favourites, cameras, storage, …), so every service has widgets the day it has a page. Each widget the assistant made
  for Home. And *Ask {assistant} for a widget* for anything else (it makes a Home widget from a connection's tool, which
  then is in the list). *Why:* John asked for widgets for all kinds of servers and services; the pages already say what
  matters for each service, so the widgets come from them.
- **DK-140 Touching a widget.** A server opens its own screen (DK-83); any other widget opens big, its largest form over
  the dashboard, with *Back*; Whombat's own open what they did before (the pill's modal, *Done today*'s list). *Why:* a
  full service page on a touch screen would be a second app; the widget's largest form is the page's essence.
- **DK-141 One drawing everywhere.** The widgets, the grid, the top bar and the modal are drawn by one package,
  `@whombat/screen` (pure grid and form rules for every app, React for the box's console, the web app's screen page and
  the editor), so the editor shows exactly what the screen will. The box's console takes it like `@whombat/brand`.
- **DK-142 The runtime says what, the screen says how.** The runtime resolves each placed widget into a view (data, no
  size: a figure, a list, posters, a chart, a camera still), refreshed at the widget's pace; the screen picks the form
  for the cells it has. Pictures come only through the runtime — the box's console through the desk socket, a screen
  elsewhere through the session — signed for the thing they belong to, never fetched by the screen from the service.
- **DK-143 Editing.** *Superseded in part by DK-167* (a widget moved onto exactly one other changes places with it). Settings → Screens → a screen → *Edit layout*: the screen at its real shape with live data and its
  cells showing; pages along the top with *+ Page*; *Size* and *Pages turn*; *Add a widget* beside it (search, grouped by
  where they come from, drag in or *+* for the first free spot, smaller if it must). A widget is chosen by a touch: a
  corner to resize (it redraws as it grows), × to remove, its settings beside it. A spot that is taken says so (red) and
  nothing is pushed aside. Arrow keys move, Shift and the arrows resize, Delete removes. Changes are a draft until *Save*;
  *Try on the screen* shows the draft there for a minute; *Undo*. *Why:* the mockups John approved.
- **DK-144 The widgets' own settings.** *What’s going on* holds DK-102…DK-106's choices (which things may show, Always ·
  When it matters · Off); *Servers* holds the strip's order; a server widget its server and chart range; a panel widget
  which thing and panel; any widget with private words *On a locked screen: Show it · Hide it*.
- **DK-145 The phone edits too.** The same Screens list and the same editor, with the grid drawn as labelled tiles and a
  chosen widget moved and sized with buttons (44 px), *Add a widget* as a sheet.
- **DK-146 A screen elsewhere.** On a tablet, or a computer by a monitor, open Whombat's page on the local network
  (DK-150) and choose *Use as a screen*: it shows six letters for 10 minutes. In *Settings → Screens → Add a screen*
  the person types them, names the screen, chooses its pop-ups and whether it starts as a copy of the box's layout
  (rearranged for its shape) or an empty page. The device is then a screen, not a person's device (its endpoint is
  enrolled as a `display`): its sessions see only the `screen` operations — its own state, its lock, the pictures its
  widgets name — and nothing else. *Remove* in Settings ends it at once (its endpoint is revoked). *Why:*
  a kitchen tablet must not open the person's Whombat.
- **DK-147 A monitor on the box.** A monitor plugged into the box is a screen of its own (*Monitor on this Whombat*, with
  the monitor's name), shown beside the box's own display, until it's unplugged; it keeps its layout for the next time.
- **DK-148 Limits.** 6 pages per screen, 24 widgets per page, 8 screens besides the box's own, 64 different widgets
  resolved per screen. Views refresh: servers every 15 s, panels at their page's pace (never under 10 s), figures and
  the assistant's widgets every minute, camera stills every 10 s while shown.
- **DK-150 A screen elsewhere is added on the local network, not through the hosted app.** Over the hosted app a
  device reaches the box with tickets control gives a signed-in Whombat account, so a screen would have to stay signed in
  to the person's account — a kitchen tablet holding their account (billing, their Whombats). The box's own page on
  the local network (and over Tailscale) needs no account: *Use as a screen* is offered there only. Screens through the
  hosted app wait for control to give a screen tickets of its own, bound to its key. *Why:* found while building it; the
  screen must hold nothing of the person's.
- **DK-149 Older parts.** `DeskGlance.grid` is optional: an older console keeps drawing the calm glance, which the
  runtime keeps filling; a new console on an older runtime draws the calm glance. Settings shows *Screens* where the
  runtime answers `desk.screens`, else the old *Screen* tab.

## The question in the pop-up (2026-10-27, evening)

John, 2026-10-27 (main checkout), after screens of widgets went live with the pop-up showing only *Answer* for a
question: “Implement the Question pop-up please”. Ids: DK-151 here, DK-S230 (`desk-display-server.md`, the drawing),
appliance CG-397… (`console-gui.md`).

- **DK-151 The pop-up carries the question.** On the box's own screen (and its monitors) a question or approval in the
  pop-up shows what its card shows, without a second step: who asks (another agent or a person by name), the title, the
  assistant's question and what happens (the quote), the command or the target (one short line each), and its own
  answers — its Approve in its own words (“Restart Plex”), the wider choices (each behind the PIN, with a lock), *Deny*
  where it may be denied, *Answer* in Talk for a question — then *Not now*, which puts it away on this screen as for an
  outage (the ask keeps waiting in the pill; the card's “not until tomorrow” stays on the card). A risky one asks for the
  PIN first, one only the phone may approve says so with why, and an answer on its way holds the buttons. Locked, the
  pop-up keeps to the lock's view (no words, no answers: CG-50) and offers *Unlock to answer*; once unlocked it shows the
  question in full. A screen elsewhere is unchanged: it says where to answer (DK-138). *Why:* the mockups' question had
  its own answers on it; *Answer* that opened another card was a step between seeing and answering.


## A server's widgets, and *Add a widget* that folds (2026-10-27, night)

John, 2026-10-27 (main checkout), after screens of widgets went live: a preview as a tooltip when the pointer rests on
a widget in Settings → Screens for two seconds or more; the widgets foldable per section and per service, only
*Whombat and Dusty* and *Servers* folded at first; the CPU / memory / disk card with the bar in blocks back; several
widgets per server to choose from; and research into widgets for the other connections. Ids: DK-152…DK-156 here, web
AP-5968… (`docs/app/decisions/desk-display-web.md`), phone AP-6032… (`desk-display-android.md`). No contract change:
a server's part is its widget's `opts.show`, drawn with the views every screen knows.

- **DK-152 A server's figures in blocks again.** A server widget draws its processor, memory and disk as the server
  cards did (appliance `84e93977`): the short name (CPU, MEM, DISK) in mono, blocks lit up to the value — amber, then
  red, at the box's own tones (`DESK_BOX_TONES`) — and the percentage. Twenty blocks where there's room, fewer on a
  narrow widget so each stays about 9 px wide, never fewer than ten. One cell high and three or more wide it is the
  card itself: its name, why it isn't fine (in its colour) or how long it's been up, and the three lines; two high it
  adds its processor over the range under them. *Why:* John asked for the card back; the blocks read from across a room.
- **DK-153 A server offers several widgets.** Besides its overview, a server widget can show one part of it
  (`opts.show`): *Processor*, *Memory* and *Network* (a chart over the widget's range with the figure now: cores and
  load, used of total, in and out), *Storage* (each volume fullest first, how much is used in all), *VMs and
  containers* (how many run, the busiest first, green while running), *Temperature* (the hottest sensor big, how close
  it is to too hot, the others under it) and *Alerts* (its open alerts, the worst first, private on a locked screen).
  They're read as the server's own screen reads it (`readServerParts`), once per server and range for all its parts,
  kept 30 s, a minute or two minutes by range. A server that's off says so instead of old figures; one that's gone says
  so as the overview does. Touching a part opens the server's own screen. *VMs and containers* is offered only for a
  server that runs any, *Temperature* only for one that reports it. The sizes follow what a part draws (`@whombat/screen`
  `SERVER_SHOW_VIEWS`); choosing another part shrinks the widget when the new one is smaller. *Why:* John asked for more
  widgets per server; these are what the server's own screen already shows, so nothing new is read from the servers.
- **DK-154 Each server is a group of *Add a widget*.** The runtime lists a group per server (`key` `server:<id>`, its
  name and mark) with its overview first and then its parts; the apps show them under one *Servers*. An older app
  shows each server as its own group. *Why:* 48 items per group would cut a fleet's parts short, and a server's
  widgets belong together.
- **DK-155 *Add a widget* folds.** *Superseded by DK-163* (each service is one row; nothing folds). Every section folds under its heading: *Whombat and {assistant}*, *Servers* (and in
  it each server), each connection or device, *Made by {assistant}*. *Whombat and {assistant}* and *Servers* start
  folded, everything else open, each server folded inside *Servers*; a search opens whatever matches, and *Didn’t fit*
  never folds. Folding lasts while the editor is open. Same on the web and the phone. *Why:* John asked; the
  connections were below two long sections.
- **DK-156 A widget's preview before adding it.** *Superseded in part by DK-163* (a service's row previews its main view). On the web, resting the pointer on a widget in *Add a widget* for half
  a second (or keeping the keyboard on its *+* as long) shows a preview beside it: the widget drawn live at the size it
  starts at, with what it shows now (`desk.screen.views`). It stays on the page, never under the sidebar or off the
  window: left of the row where it fits, else right of it, else under or over it (the panel under the screen on a
  narrow window). It goes when the pointer leaves, a drag starts or Escape is pressed. The phone has no hover and shows
  none. *Why:* John asked; seeing it beats reading its line. Two seconds felt slow, and on a narrow window the preview
  went off the right edge (John, 2026-11-10).

## Nothing private on a locked screen, and widgets made for a wall (2026-10-28)

John, 2026-10-28 (main checkout), after the research into every connection's widgets
(`~/.cache/wb-tmp/widget-research/report.md`): “Yes continue” to fixing what a locked screen leaked first and then
building the best widgets it found. Runtime decisions: `desk-display-server.md` DK-S231…DK-S249,
`service-dashboards.md` SD-71…SD-88 and SD-S22…SD-S34.

- **DK-157 A locked screen shows nobody's name, money or documents.** What *A summary* leaves out (DK-138) now covers
  every widget that names a person or says where they are, shows money, or names a document: who asked for a film,
  who's home, locks and alarms, device and client names, e-mail addresses, costs and payments, file names, someone's
  review queue. Where a widget is fine for a passer-by but for one name, the name leaves the widget instead. *Why:* the
  research found these on locked screens; a kitchen tablet is for everyone who walks past.
- **DK-158 Widgets made for a wall, from what Whombat already reads.** Besides each panel of a page, a connection offers
  widgets shaped for a glance: Home Assistant's *Home now* (private), *Weather*, *Rooms* and *Energy today*; Pi-hole's and
  AdGuard's *Ads kept out today*; Sonarr's *Tonight on TV*; *All backed up* for Proxmox Backup Server, Synology and
  TrueNAS; Protect's *Doorbell* and *All cameras*; Seerr's *On its way*; Immich's *On this day*; Mollie's *Today vs last
  week*. Each only where the service has the data, from reads the page makes anyway (Immich's memories and Home
  Assistant's weather and energy are new, cheap and only read while shown). *Why:* the best widgets the research found;
  a panel drawn small isn't a wall widget. The media chain across Seerr, Sonarr, Radarr, SABnzbd and Plex waits: it
  needs a widget of Whombat's own, a contract change.

## The person's own accounts on screens, photos and boards (2026-10-28)

John, 2026-10-28 (main checkout): “Implement the new Calendar, mail and pull-request widgets from Google, Microsoft and
GitHub. And the two new ways to draw widgets.” (the research's account widgets and its `photo` and `board` views).
Contracts 3.7.0, session protocol minor 2. Runtime decisions `desk-display-server.md` DK-S250…, web
`desk-display-web.md` AP-6100…, phone `desk-display-android.md` AP-6120…, appliance `console-gui.md`.

- **DK-159 The person's own accounts have widgets.** A Google or Microsoft 365 account with its calendar offers *Today*
  (what's left of today's meetings, each at its time) and *Next meeting* (what, when, where, in how long); one with its
  mail, and an Email (IMAP) account, offer *Unread mail* (how many unread in the inbox, and the newest senders and
  subjects where there's room); the Whombat's GitHub offers *Pull requests* (what's open, whose, and whether its checks
  pass) and *Waiting for review*. A widget names the account by `account:<id>` (`account:github` for GitHub), lists
  under *Your accounts* in *Add a widget*, and reads as the screen's person with their own connection. Calendar and
  mail are private on a locked screen; pull requests aren't. Only the screen's own person's accounts are offered.
  *Why:* the services with the most to show on an office screen had no widget at all.
- **DK-160 A photo view.** `photo`: one picture filling the widget with a few words under it, the next one every
  `every` seconds (two minutes unless said), no motion between them. Its pictures are larger than a page's (1280 px on
  the long side, `THING_IMAGE_LARGE_SIDE`). For Immich's *On this day* and a frame of photos. *Why:* a family screen
  wants one big photo, not a row of thumbnails.
- **DK-161 Older apps get what they can read.** A newer kind of view or ref would make an older app refuse the whole
  answer. The session already agrees a protocol minor: at minor 1 the runtime leaves `photo` and `board` views and
  accounts' groups out of *Add a widget* and the editor's views (such a widget shows empty there until the app is
  updated); minor 2 gets everything. *Why:* a phone that updates a day later shouldn't lose Settings → Screens.
- **DK-162 A board view.** `board`: many small named tiles, each a colour and maybe a short value (up to 48), for
  everything fine at a glance where a list stops at twelve rows: every container, every device, every repository.
  *Why:* the research's second missing way of drawing.

## The editor like the Overview (2026-11-26)

John, 2026-11-26 (main checkout): “I like that way how we configure a widget on the overview dashboard, we can simply
select which view we want for this widget, rather than selecting it from a long list like on the screen editor.” *Add
a widget* listed every view of every service as its own row (Fusebox alone had twelve). Ids: DK-163…DK-168 here, web
AP-9970… (`docs/app/decisions/desk-display-web.md`), phone AP-9980… (`desk-display-android.md`). No contract or runtime
change: everything is the apps' and the shared rules' (`@whombat/client/desk` `catalogRows`, `catalogGroupOf`,
`chooseWidget`, `sizePresets`, `tidyPage`, `moveWidget`).

- **DK-163 *Add a widget* lists each service once.** Each server, connection or device and each of the person's
  accounts is one row: its mark, its name, a short line (a server's and an account's main view's line; a connection's
  other views by name, since its figures' line is the same for every one), *On this page* when any of its widgets is on
  the open page, its main view's size and *+* (and dragging on the web). Adding it adds its main view — the first of its
  group: a server's overview, a connection's figures, an account's main panel — at that view's size, exactly as adding
  that view did, and chooses it so its settings show (the phone opens its sheet). The connections and devices are under
  one *Connections*; *Servers* and *Your accounts* keep their headings; nothing folds. Whombat's own are small tiles
  (icon and name, three to a row, a check when on the page) at the top; the assistant's Home widgets stay one row each;
  *Didn’t fit* is as it was. A search lists single views, named with what they belong to (“pve-01 · Storage”, “Plex ·
  Now playing”), so a view is still found directly. *Why:* John asked; choosing a view belongs to the widget, as on the
  Overview.
- **DK-164 *What it shows*.** A chosen widget's settings list every view of its connection, server or account as the
  Overview's gear does: one option per view with its name and line, the one it shows pressed (a connection listed only
  partly is read whole first). Choosing one changes the widget in its place — figures and panels alike — its size fitted
  to the new view's smallest and largest; where growing has no room it stays and says so. Its chart's range and a photo's
  pace stay; *On a locked screen* stays only where the new view is private too. The *Server*, *Connection* and *Account*
  pickers above it still move it to another one. *Why:* the Overview's way, which John likes.
- **DK-165 Size as shapes.** Above the steppers, up to five shapes: *Small* (its smallest), *Normal* (the size it
  starts at), *Wide* (twice as wide), *Tall* (twice as high) and *Large* (both), each within its largest and the grid;
  one that equals an earlier one or doesn't fit its limits isn't offered. Each is drawn as its cells with its name and
  size, the one it is pressed; choosing one resizes it in place, refused as resizing is when there's no room. *Why:* the
  Overview's Small, Wide, Large, with the steppers kept for one cell at a time.
- **DK-166 *Tidy up*.** A page's *Tidy up* packs its widgets up and to the left in reading order, each keeping its size
  at the first free spot; one Undo step; “Tidied up.” or “Already tidy.” Nothing is dropped; a page that couldn't be
  packed that way is left as it was and says so. *Why:* moving widgets one by one into the gaps was the slow part.
- **DK-167 Two widgets change places.** A widget moved (dragged, arrows, the phone's arrows) onto exactly one other
  widget takes that one's top left corner, and the other takes its old one, each keeping its size — when both then fit
  without covering anything else; otherwise the spot is taken as before. The web shows it while dragging (the landing
  spot not red, the other drawn faint where it goes); it says “Swapped Clock and Weather.” *Why:* a swap isn't pushing
  aside, and it's what people mean when they drop one widget on another.
- **DK-168 The keys behind *?*.** On the web the keys line under the screen is a small *?* (*Keys*) that opens them,
  with swapping and *Tidy up*. *Why:* the line was long and read once.
- **DK-200 *Weather*.** One of Whombat's own widgets (weather-news.md): the forecast where this Whombat is, from one
  cell (its symbol and temperature) to eight by four (the next hours and the days ahead), its own `weather` view; every
  form with room says “Data from MET Norway”. Without a place it says “Choose where this Whombat is in Settings”, and
  “Can’t read the weather just now” when MET can't be read. Shown as it is on a locked screen. *Why:* John asked for the
  weather on the screens, a morning page among them.
- **DK-201 *News*.** One of Whombat's own widgets: the newest headlines of the news sites the person turned on, each
  with its site and time, as a list. With no site on: “Choose your news in Settings”. Shown as it is on a locked
  screen. *Why:* John asked for local news; headlines are public.
