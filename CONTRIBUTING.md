# Contributing

This repository is free software under the AGPL-3.0 (`LICENSE`), made by Cybex BV. Issues and pull requests are both
welcome.

- **Issues:** report a bug or suggest a change in the issues. Say what you did, what you expected and what happened.
- **Pull requests:** we accept a pull request once you have agreed to the Whombat contributor agreement
  (`docs/legal/contributor-agreement.md`). It lets Cybex BV publish your work under the AGPL-3.0 and also offer
  Whombat under other terms, and you keep your copyright.
- **How a pull request lands:** we merge it here, in this repository, once its checks pass (`public-ci`, and the
  maintainers' `guard` check). Run `pnpm check` first (`CLAUDE.md` has the commands); for a change in `appliance/` or
  `hosts/`, that folder's own tests (`appliance/AGENTS.md`, `hosts/AGENTS.md`).
- **Example values only:** fixtures and docs use the example ranges and names (`10.100.0.0/16`, `203.0.113.0/24`,
  `2001:db8::/32`, `example.com`), never a real network, address or account.
- **Larger changes:** open an issue first, so we agree on the approach before you write the code.
- **Code that isn't yours:** name its source and licence in your pull request; the licence must be compatible with the
  AGPL-3.0.
- **Security or privacy issues:** never in a public issue. Report them privately, see `SECURITY.md`.
- **Help with your own Whombat:** product support goes through your Whombat account.
