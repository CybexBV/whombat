# What's new in Whombat

New things and fixes you can notice, newest first. Every Whombat on Beta gets them within the hour; Production gets
them once they have been tried on Beta.

## 28 November 2026

- Keep a copy of your backups somewhere else: under Settings → This Whombat → Backups you can add a bucket at
  Backblaze, Cloudflare, Hetzner, Amazon or any other S3 storage. Whombat checks it first, copies each new backup
  there and clears old ones by the same rule. If a fire or a theft takes your Whombat and its backups together, a new
  Whombat comes back from the copy. When the copy keeps failing, your Inbox says so.
- Does it really work? Nextcloud, Immich, Paperless-ngx, Jellyfin, Plex and Home Assistant pages can test whether
  the service really works, by opening a file, your newest photo or document, a library's newest item or a sensor's
  latest reading. Run now says where it got stuck, and whether the sign-in Whombat uses lost access or the service
  itself is broken. Watch it runs the test every 15 minutes and tells you when it fails twice in a row.
- Open to the internet, at the end of Servers: everything your proxy, Cloudflare tunnels and router let in from the
  internet, what each leads to and how it’s protected, with what’s worth a look first. It also says what Whombat
  couldn’t see, like ports your router opens by itself.
- When something new opens to the internet, Whombat tells you once and asks whether it’s meant. Press This is meant
  and it won’t point it out again.
- A new opening counts as new for two weeks, and a service test that gets a sign-in page instead of the service says
  so instead of passing.
- Ask your agent “what can the internet reach?” and it answers from the same list.
- Whombat can update your Docker Compose apps: an app with a newer version says “Update available” on its server’s
  page and its own page, with Update. Whombat asks first, installs exactly the version it asked about, restarts only
  that app, and puts the previous version back by itself when the new one doesn’t start, even if the server restarted
  halfway. A database, a new major version or a version Whombat can’t tell always asks, and says why. If the app
  changed after you said yes, Whombat leaves it alone and says so.
- A server’s care plan can update its apps on Sunday night: the safe ones by themselves, the others as one question.
- Each server, service and device’s History now shows what changed beside what went wrong: a new version, a new
  container image, installed updates and restarts, new firmware, a proxy host or tunnel route edited. Each says
  whether Whombat did it or it was changed outside Whombat.
- When your assistant looks into a problem, it sees what changed just before and tells you, without guessing a cause.
  You can also ask it what changed on something.
- Whombat keeps a copy of the settings of OPNsense, Pi-hole and Nginx Proxy Manager every night. Download the newest
  from the service’s page; History tells you what changed in them.
- Automations can act without AI, right on your Whombat, even when the internet is down: ask your assistant to shut
  your servers down safely when the power goes out, restart a server or machine, or switch a light when Home Assistant
  sees something change or your doorbell rings. Trying one out asks you before it changes anything.
- Add a Windows PC as a server: choose Windows PC in Add a server and paste the line into PowerShell opened as
  administrator. Whombat watches its processor, memory, drives and network, says whether its virus protection is on,
  shows BitLocker and waiting Windows updates, and can restart it. Installing updates stays yours, in Windows Update.
- In Dutch, Whombat now also says how an app update went, a new server’s care plan and what an automation that acts
  without AI did. On a phone, that automation’s line on its run page shows whole instead of being cut off.
- New page: What’s protected. It lists everything that holds data (your Whombat, servers, machines and services like
  Home Assistant) and says whether a copy is on another machine, only on the same machine, or not backed up as far
  as Whombat can see. Open it under Servers or Settings → This Whombat → Backups, and ask your assistant to set up
  backups for anything that isn’t safe yet.
- What’s protected shows your Whombat’s copy somewhere else, and says when copying there fails.
- What’s protected counts a backup as copied or kept only once one has worked, where it really is. A backup plan that
  never worked says so, and a copy somewhere else says “nothing to copy yet” until there is a backup.
- Whombat can test your Proxmox backups: once a week in the quiet hours it restores one machine’s backup as a copy with
  its network off, checks that it starts, and deletes it again. Your real machine isn’t touched. Turn on “Test my
  backups” on the What’s protected page; the result shows on the machine’s page.

## 27 November 2026

- Whombat speaks Dutch too: choose Nederlands under Settings → You → Language to switch the app, your assistant,
  dashboards, notifications, emails and your Whombat’s screen.
- Your agent’s face shows what it’s doing: it thinks, works, waits for you, is glad when a run is done and says sorry
  when one fails. It blinks, has a little move of its own, and you can tap it. Turn it off under Settings → Moving
  faces.
- While your agent works on an answer, its face shows beside “is thinking” in the chat, on the web and the phone:
  you see it think, get to work and look at you when it needs you.
- On your Whombat’s screen the face listens, thinks and talks along with a spoken answer, and dozes while nobody’s
  there.
- This page is in the app now: open What’s new under Settings → This Whombat → About. After an update, the app
  tells you once, with a link here.
- An automation that fixes a report keeps going after you send its T3 Code thread more work from the report’s own
  Chat thread: it can still read that thread and its review.
- Restarting such a run never skips a review that asked for changes, and the fix is told to keep the commits its
  review read.
- A fix that doesn’t get through is worked on again by itself: when its review asks for changes, a step fails or
  the pull request’s checks fail, Whombat sends it back, up to ten tries, and asks for you only when that no longer
  helps.
- A report automation can ask for up to ten review rounds instead of three.
- A fix’s review now says which of its findings are blocking and which can wait. Only blocking ones hold a fix up;
  the rest are written down in the pull request, so a fix isn’t reviewed round after round over small things.
- In a repository that runs no checks, a reviewed fix merges after four minutes instead of ten.
- When GitHub fails for a moment while a pull request is opened, Whombat tries again by itself.
- Three report fixes can be worked on at the same time instead of two.

## 22 November 2026

- Automations can now read your mail and act on it, and automations that change your connected services are switched
  on.
- Mail and messages from other people are handled walled off from your own files, Vault and memory.
- When you approve something, the approval only works for the connection it was asked for.
- You can change more settings of your connected services from Whombat.
- Checking disk usage never wakes up a sleeping disk.
- If an update turns out to be bad, Whombat can stop it from reaching any more boxes at once.
- Turning off the Dutch voice removes it from your Whombat completely.
- You can choose a separate AI model for background work.
- The Appliance Terms and the Subscription Terms have a new version: they name the seller, say Claude Code comes from
  Anthropic, list only the keys a self-installed Whombat has and carry the Dutch voice's use restrictions. An app that
  hasn't updated yet keeps working.
- The iPhone app has a public TestFlight link: tap Join on TestFlight under Get the app, no invite needed.

## 21 November 2026

- The Android app keeps your chats up to date, crashes less, explains its notifications setting honestly and is a
  smaller download.
- Claude Code is installed straight from Anthropic's own download site.
- The Dutch voice isn't built into Whombat any more: turn it on in Settings when you want it, and agree to its
  licence there.
- Commands the agent runs on your Linux servers keep their `$` and `${name}` variables.
- Payment pages show Cybex as the seller, and payment problems show their real reason in the app.
- A new account is free: Whombat Link is the only thing you pay for.
- Claiming a Whombat is safer: the box proves who it is before your name is sent, strangers can't spoil the link on
  its screen, New letters never lock out your own phone, and the screen names a second way in.
- Whombat is open source, built from one public repository.

---

**Keeping this page up to date.** A change people can notice adds one line here, in the same pull request, under
the date it lands on `main` (a new date heading when there is none yet). Write it for the person who uses Whombat,
not for a developer: what they will see or can do now, in one plain sentence, with no version numbers, commit
hashes or file names. Changes nobody can notice (refactors, tests, internal tools) don't get a line. Everything
above the line is what the apps show as What’s new.
