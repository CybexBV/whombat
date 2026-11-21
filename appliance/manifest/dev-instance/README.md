# The development environment's public documents

These are the public trust documents of the development environment. The Whombat image carries them for two reasons,
until the cleanup release removes this folder (docs/runbooks/updates.md, “One environment”):

- **The development environment.** A box whose environment file says `dev` (`nix/profiles/environments.nix`) takes its
  support CA, licence keys and AI client channel keys from here. Nothing writes `dev` any more.
- **The interim root.** `tuf-root.json` is an earlier root of the update repository's chain (version 2, one online
  key), which the GitHub repository at releases.whombat.com continues. The image pins `manifest/prod/tuf-root.json`
  (three offline root keys, two of them needed). `nix/profiles/prod-instance.nix` passes this file only as
  `whombat.helper.interimRoot`, the one root of a single key that `nix/modules/manager.nix` lets a production image pin.
  A box installed from an image that pinned it walks the chain from here to the current root;
  `tufrepo check-newer --root manifest/dev-instance/tuf-root.json` checks that walk (docs/runbooks/updates.md).

| File | What | Read as |
|---|---|---|
| `tuf-root.json` | the development TUF repository's root, version 2: one key per role | `whombat.helper.interimRoot` |
| `licence-keys.json` | the development control's licence key set, env `local` (the licence is inert) | the `dev` environment's `licenceKeys` |
| `client-channel-keys.json` | the AI client channel's key document, env `local` | the `dev` environment's `clientChannelKeys` |
| `support-ca.pub` | the development support CA's public key, for remote help on a `dev` box | the `dev` environment's `supportCaKeys` |

All four hold public keys only. They are development keys: the production checks refuse the development licence keys
and support CA (`nix/modules/licence.nix`, `nix/modules/support.nix`, `nix/modules/environment.nix`), and nothing new
should trust them.
