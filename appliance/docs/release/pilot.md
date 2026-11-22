# Whombat pilot: what you get and how to start

This is the package for a pilot customer of the managed Whombat appliance. The first part is written for the
customer; the last two sections (“Known limits” and “Before a pilot can start”) are for us and for the customer's
technical contact.

> **Status: draft.** No pilot has started. Several items below depend on release gates that are still open
> (see “Before a pilot can start”). Contact details are placeholders.

---

## What you get

- **A Whombat appliance**: a small computer that becomes your Whombat. It keeps everything — your
  conversations, files, repositories, approvals, schedules and agent work — on the box in your office. It needs
  power and a wired network connection; it only connects out to the internet, nothing needs to reach it.
- **A claim card** in the box, for claiming the box without a screen. Keep it until you've claimed the box, then
  store it like a key.
- **A disk recovery card** in the box. Only needed if the box itself has to be repaired, reset or read without
  starting it. Store it somewhere safe and separate from the box.
- **The Whombat app** at `https://app.whombat.com` (during the pilot, the address we give you), and the Android
  app. You use Whombat through these; they talk to your box through an encrypted connection that Whombat's
  servers can pass along but can't read.
- **Updates**: the box updates itself at quiet moments, one step at a time, and goes back to the previous version
  if an update doesn't work. You'll be asked to join the “pilot” update group, which gets updates after our own
  boxes and before everyone else.
- **Support** from the Whombat team (contacts below). We can't see your content, and nobody at Whombat can log
  in to your box.

## Getting started

### 1. Plug it in
Connect the box to power and to your network with a cable. If you have a screen handy, connect it too: once the box
is online (after a few minutes) the screen says **Claim this Whombat** and shows four letters, for example `KXQM`.
Without a screen, use the claim card instead (step 2, last point).

### 2. Sign in and claim your Whombat
Your phone or computer must be on the same network as your Whombat (the same office network or Wi-Fi).

1. Open the Whombat app and sign in with your work email. We send you a sign-in link.
2. Give your organization a name.
3. Choose **Claim a Whombat**. The app says **We found a Whombat on your network**. (Several boxes? Pick the one
   whose screen you're looking at.)
4. Type the four letters from the box's screen and choose **Claim it**. You are now the box's owner, and the box's
   screen says “This Whombat is set up.” This device (your browser or phone) is the first one it trusts.

- A wrong try gives the box new letters: type the ones the screen shows now. After a few wrong tries the box waits a
  few minutes before it accepts letters again; its screen says how long.
- The app says **We couldn’t find your Whombat**: check that this device is on the box's network and that the box
  is connected (its screen says “Connecting to Whombat…” until it is), then choose **Look again**.
- No screen? Choose **Claim with a card instead** and type the Whombat code and the claim code from the card, or scan
  its QR code with the phone app.

There is nothing to compare: the app and the box check each other while you claim, so you can't claim a box other
than the one whose letters (or card) you have.

Your Whombat account in the cloud only lets you *find* your box. What you can do on the box is decided by the
box itself: resetting your email password never gives anyone access to your data.

### 3. Save your recovery kit — don't skip this
Right after claiming, the app makes your **recovery kit**: a file with a recovery key and the password for your
backups.

1. Save the file somewhere safe that isn't this computer (a password manager, an encrypted USB stick, or print it
   and lock it away).
2. The app asks you to type back two groups from the kit. That's how we know you saved it.
3. Until you do, the app shows “Recovery kit not saved”.

The kit lets you:
- get back into your Whombat if you lose every trusted device,
- read your backups without the box and without Whombat.

Nobody else has it — not Whombat, not the box. If you lose it, we can't make you a new one from the old one (see
“If something goes wrong”).

### 4. Turn on backups
Backups go to storage **you** choose, encrypted before they leave the box. For the pilot the supported storage is
a “restic REST server” in append-only mode, run by you or your storage provider:

1. Set up the storage (we send your technical contact a setup note). It must be set to **append-only**, so the box
   can add backups but never delete them. Keep the separate “delete/clean-up” login away from the box.
2. In the app's backup settings, set the destination: the storage address and the box's login for it.
3. Start a backup now. When it finishes the app shows the time of the last backup and what it covered.

Without a destination the app says **Unprotected**: your data exists only on the box. Each week the box also
restores its latest backup privately and checks it (a “drill”); the app shows when that last worked.

### 5. Add your other devices
A Whombat is one person's: yours, on as many of your own devices as you like.

- **Add another device** (a second browser, a phone): on the new device choose “Add this device”, it shows a code
  and a fingerprint; on a device you already use, enter the code, check the fingerprint matches, and choose
  “Let it in”.
- You manage your devices from any device you already use. Keep at least two working devices and your recovery kit.

### 6. Connect your AI provider and GitHub
You connect your own accounts.

| Provider | How you sign in | For |
|---|---|---|
| OpenAI Codex | your own OpenAI API key | your own work and your own schedules |
| OpenAI Codex | a Business/Enterprise access token you create (with an expiry of 90 days or less) | your own work and schedules |
| Anthropic Claude | your own Anthropic API key | your own work and schedules |
| GitHub | sign in with GitHub from the app (device code), or paste a personal token | your own repositories |

In the app's provider settings. The sign-in happens in your browser with the provider; nothing is typed
into a terminal. Signing in with a ChatGPT or Claude subscription is **not available** in the pilot (we are
waiting for the providers to confirm it's allowed in a product like ours).

Using your own API key means the provider bills you directly. Whombat never adds its own paid fallback: if your
key runs out, your agent stops and says so.

## Everyday things

- **Is it working?** The appliance status in the app's settings shows the connection, the version, update status, backup status and
  each provider sign-in.
- **Updates** happen by themselves at quiet times; running work is never cut off for an update. If an update is
  waiting, the app says why.
- **A device is lost or stolen:** remove it from the device list on another device. It is disconnected at once
  and its local copies are cleared the next time it connects. We can't erase copies someone already saved
  elsewhere.

## If something goes wrong

| Problem | What to do |
|---|---|
| The app can't reach your Whombat | Check the box has power and a network cable, and that your network allows outgoing HTTPS (port 443). Then contact support. |
| You lost your only trusted device | On a new device choose “Lost access? Use your recovery kit” and open the kit file. |
| You lost the recovery kit but still have a trusted device | Your Whombat keeps working and backups stay readable (you can show the backup part of the kit again in the backup settings). A replacement recovery key can only be made with the old kit — tell support; see the known limits. |
| The box is broken or lost | We send a replacement; you restore it from your backups with your recovery kit. The old box is locked out. |
| You want your data out, without Whombat | Use the recovery tool with your recovery kit: it reads your backups and exports everything in open formats, no Whombat account or server needed. |
| You stop the subscription | Nothing is deleted. Your box keeps its data; backups, export and recovery keep working. |

## Support

- Email: `<support@whombat.com>` (placeholder)
- Urgent (box down, suspected security problem): `<phone / on-call>` (placeholder)
- Security reports: `<security@whombat.com>` (placeholder)
- Pilot contact at Whombat: `<name>` (placeholder)

What support can see: your organization, your boxes and whether they are online, their version and update/backup
status, and push delivery counts. What support can't see: any of your content, the names on the box,
or your provider accounts. If we need more, we'll ask you for a diagnostic report, which you can read before
sending it (this is still being built; until then we'll ask for screenshots of the appliance status screen).

---

## Known limits of the pilot (for the customer's technical contact)

- **Hardware:** the pilot box has not finished hardware qualification (power loss, watchdog, TPM, Secure Boot and
  firmware are verified in virtual machines only). Keep it on a UPS if you can.
- **Apps:** web and Android. No iPhone/iPad app yet. QR scanning with a real phone camera is not yet verified.
- **Providers:** API keys and Codex access tokens only; ChatGPT and Claude subscription sign-in are not offered.
- **Not available on the managed box:** Google account connections, inbound webhooks for automations, public
  Feedback intake, API tokens, sign-in by email code, “trusted” agent access (agents always run sandboxed), ACP
  agents, host directories. Each shows an explanation in the app.
- **Backups:** one kind of destination (restic REST server, append-only). Backups are complete (database, files,
  repositories including unpushed and uncommitted work, provider logins, configuration); provider logins may need
  signing in again after a restore.
- **Recovery kit loss:** if the kit is lost, the recovery key cannot be replaced (a new key must be signed by the
  old one, by design), so kit-based recovery stays tied to the lost kit. Backups remain readable to you.
  There is no way yet to revoke a lost kit without it.
- **Diagnostics:** no in-app diagnostic report yet; support relies on the status screens.
- **Moving from the current Whombat (app.whombat.com):** importing your existing data is not available yet. A
  read-only check can show what would carry over (see the cutover plan); pilot boxes start empty.
- **Content already downloaded** to a device can't be erased remotely.
- **Metadata:** Whombat's servers see when your devices connect, how much data flows and which box belongs to
  which organization — never the content.

## Before a pilot can start (internal)

Each item links the release checklist (`README.md`):

- Production control and relay deployed on `api.whombat.com` / `relay.whombat.com` (X-05, X-06) and the hosted
  UI published on the pilot host (cutover plan, phase 3).
- Production TUF root ceremony and release signing; pilot boxes pinned to the production root (X-05).
- Runtime and provider Nix closures built and in a signed release tuple (pins placeholders).
- Hardware selected and at least the pilot units run through `hardware-qualification.md` (X-04), or the customer
  explicitly accepts VM-only qualification in writing.
- Provider terms for any provider mode offered: settled (X-02 resolved 2026-09-26; X-01, Anthropic's Commercial Terms, no longer a requirement, John 2026-11-22).
- Qualified privacy/CRA review of this document and the support process (X-07).
- Support contacts and the security intake named (`vulnerability-response.md` §9).
- A signed pilot agreement covering the known limits above.
