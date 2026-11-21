# Security and privacy reports

This source is open so anyone can check how Whombat handles your data. If you find a vulnerability, or
a place where the software doesn't do what `docs/app/privacy-and-security.md` says it
does, please tell us privately first.

**Report it privately**, in either of two ways:

- GitHub's private form: [Report a vulnerability](https://github.com/CybexBV/whombat/security/advisories/new).
- Email **security@whombat.com**.

Include what you found, how to reproduce it, the commit or release you looked at, and what an attacker could do
with it. Proof-of-concept code is welcome.

What you can expect:

- We confirm receipt within 3 working days and give you a first assessment within 10 working days.
- We keep you updated while we fix it, and agree a disclosure date with you. We aim to fix critical issues
  within 30 days and others within 90 days.
- We credit you in the release notes if you want to be credited.

We won't pursue legal action against good-faith research that follows this policy: stay within your own
accounts and appliances, don't access other people's data, don't degrade the service for others, and give us
reasonable time to fix the issue before you publish.

## Which versions get fixes

Fixes ship in a new release on both channels, Production and Beta, and every Whombat installs it by itself (or asks
first, when its owner chose that). We fix the newest release, not older ones: a box that is switched off or held back
takes the fix when it updates. The apps work the same way: the web app is served fresh, the iPhone app updates through
TestFlight and the Android app by itself.

## Scope

In scope: the code in this repository.

- The runtime of a Whombat appliance (the server, the runner, the agent's commands and their sandbox, the Hermes
  plugin), the web, phone and widget apps, and the contracts and their crypto: how they keep one person's data from
  another, guard the agent's actions and handle keys, sign-in and the Vault.
- The appliance in `appliance/` (the image and its modules, the manager, the update helper, recovery, remote help,
  provisioning and the release tooling): how the box verifies updates, keeps its keys and disks, and limits what runs
  on it.
- The hosts service and the agent on each server in `hosts/`: how they enrol agents, guard remote control, consoles
  and changes to servers, and keep their keys.

Our services that are not in this repository (the accounts and Whombat Link at app.whombat.com and api.whombat.com,
the relay, the update repository at releases.whombat.com, and whombat.com) are in scope too: report them the same
way, and test them only with your own account and your own Whombat.

Known and documented trade-offs are listed in `docs/app/privacy-and-security.md` (section 9). A way to get more than
that document says, such as reading a key that should be non-extractable, or getting a page or key from the box over
plain HTTP, is a vulnerability. Out of scope: denial of service by volume, social engineering, physical attacks on
hardware you don't own, and findings in third-party dependencies that don't affect Whombat (report those upstream).
