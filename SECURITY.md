# Security and privacy reports

This source is open so anyone can check how Whombat handles your data. If you find a vulnerability, or
a place where the software doesn't do what `docs/app/privacy-and-security.md` says it
does, please tell us privately first.

**Email security@whombat.com.** Include what you found, how to reproduce it, the commit or release you looked
at, and what an attacker could do with it. Proof-of-concept code is welcome.

What you can expect:

- We confirm receipt within 3 working days and give you a first assessment within 10 working days.
- We keep you updated while we fix it, and agree a disclosure date with you. We aim to fix critical issues
  within 30 days and others within 90 days.
- We credit you in the release notes if you want to be credited.

We won't pursue legal action against good-faith research that follows this policy: stay within your own
accounts and appliances, don't access other people's data, don't degrade the service for others, and give us
reasonable time to fix the issue before you publish.

In scope: the code in this repository.

- The runtime of a Whombat appliance (the server, the runner, the agent's commands and their sandbox, the Hermes
  plugin), the web, phone and widget apps, and the contracts and their crypto: how they keep one person's data from
  another, guard the agent's actions and handle keys, sign-in and the Vault.
- The appliance in `appliance/` (the image and its modules, the manager, the update helper, recovery, remote help,
  provisioning and the release tooling): how the box verifies updates, keeps its keys and disks, and limits what runs
  on it.
- The hosts service and the agent on each server in `hosts/`: how they enrol agents, guard remote control, consoles
  and changes to servers, and keep their keys.

Known and documented trade-offs are listed in `docs/app/privacy-and-security.md` (section 9). One of them: the
appliance's own page over plain HTTP on the local network isn't protected on the way and keeps a software device key
there (section 8). A way to get more than that document says, such as reading a key that should be non-extractable or
using the HTTP page's key without being able to change that network's traffic, is a vulnerability. Out of scope: denial of service by volume, social engineering, physical attacks
on hardware you don't own, and findings in third-party dependencies that don't affect Whombat (report those
upstream).
