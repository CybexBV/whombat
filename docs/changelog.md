# What's new in Whombat

New things and fixes you can notice, newest first. Every Whombat on Beta gets them within the hour; Production gets
them once they have been tried on Beta.

## 28 November 2026

- Each server, service and device’s History now shows what changed beside what went wrong: a new version, a new
  container image, installed updates and restarts, new firmware, a proxy host or tunnel route edited. Each says
  whether Whombat did it or it was changed outside Whombat.
- When your assistant looks into a problem, it sees what changed just before and tells you, without guessing a cause.
  You can also ask it what changed on something.
- Whombat keeps a copy of the settings of OPNsense, Pi-hole and Nginx Proxy Manager every night. Download the newest
  from the service’s page; History tells you what changed in them.

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
