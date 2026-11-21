# Community edition test repository — TEST KEYS ONLY

**Every key under `keys/` is a test private key, committed on purpose.** Nothing signed with them may ever be offered
as a real community release: whoever has this repository can sign anything for a box that pins this root. A published
community edition gets keys of its own from a custody ceremony first (Whombat HE-62; appliance UP-X27, NX-445).

What it is: the community edition's own TUF repository (Whombat HE-58), as `tufrepo init --dir … --env dev --edition
community --root-valid 87600h` made it on 2026-10-24, plus `tufrepo add-clients-role`. A community repository holds no
assignment key (a community box has no control; its manager takes the newest release) and signs
`whombat-community-YYYYMMDD.N` ids only.

- `metadata/1.root.json` is what the community image pins: `manifest/community/tuf-root.json` (the flake check
  `community-trust` keeps them the same). Root valid until 2036-10-21.
- `manifest/community/client-channel-keys.json` is `tufrepo clients-keys` of it.
- The key ids are in `helper/pkg/trust/devroot.go` (`DevelopmentKeyIDs`): a `prod` box refuses this root, and
  `manager.nix` refuses to build a prod image that pins it.

Use: `release/build community` copies this directory to its own working repository (never writes here), publishes the
release into that copy and serves nothing; the install test (`docs/runbooks/install.md`, “The community edition in a
VM”) serves the copy's `metadata/` and `targets/` (never `keys/`) from a throwaway container.
