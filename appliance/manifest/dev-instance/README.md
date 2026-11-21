# The development stack's public documents (NX-60; since ONE-02 the interim ones of the Whombat image)

There is no DEV image any more (nixos.md NX-522). These files stay for two reasons until the cleanup release after
Home's move (docs/runbooks/updates.md, “One environment”):

- The Whombat image (`nix/profiles/prod-instance.nix`) pins `tuf-root.json` and `client-channel-keys.json` from here
  until the key ceremony's root and the env prod client keys are committed in `manifest/prod/` (ONE-05): the GitHub
  repository continues this root's chain, and its client channel is env local until it is switched.
- The image's development environment (`nix/profiles/environments.nix`, a box whose environment file says `dev`: Home)
  takes its support CA, licence and client keys from here.

They were copied from the dev instance so the image builds from the repository alone:

| File | What | Source on the dev instance |
|---|---|---|
| `tuf-root.json` | the dev TUF repository's current root, version 2 (`whombat.helper.tufRoot`) | `https://updates-dev.whombat.com/metadata/root.json` = `~/.whombat-stack-dev/env/manager/tuf/metadata/2.root.json` |
| `licence-keys.json` | control's licence key set, env `local` (`whombat.licence.keys`) | `https://api-dev.whombat.com/v1/licence/keys` = `~/.whombat-stack-dev/env/appliance/licence-keys.json` |
| `client-channel-keys.json` | the AI client channel key document (`whombat.clients.channelKeys`) | `~/.whombat-stack-dev/env/manager/client-channel-keys.json` |
| `support-ca.pub` | the DEV support CA's public key, remote help's certificates (`whombat.support.caKeys`, NX-416); a placeholder without a key until the lead installs DEV control's | `support-ca.pub` beside DEV control's `SUPPORT_CA_KEY_FILE` (`dev-init`) |

All three are public keys only. They were copied on 2026-09-27 (licence kid `lic-local-2026-09-27`; clients kid
`clients-local-b09ae3ae447a`). The root was refreshed the same day after John rotated the instance's top-level TUF keys
(PI-13): version 2, root key `cd090e03…`, targets `4e124f9b…`, snapshot `4e5ed3fd…`, timestamp `5573531f…`, expires
2027-09-27, signed by the old and the new root key. An image pins the **current** root, not version 1: a box that
trusted version 1 would still walk to version 2, but version 1's keys were public, so nothing new should start there.

The instance generates all of them itself (`dev/up`: `tufrepo init --env local` with random keys, control's
`dev-init`) and keeps them until it is reset (`dev/up --reset`, `dev/down --purge`). **After a reset, refresh these
files and rebuild the ISO** (an installed box keeps trusting the old root and can't update any more; reinstall it):

```sh
curl -sf https://updates-dev.whombat.com/metadata/root.json -o manifest/dev-instance/tuf-root.json
curl -sf https://api-dev.whombat.com/v1/licence/keys -o manifest/dev-instance/licence-keys.json
cp ~/.whombat-stack-dev/env/manager/client-channel-keys.json manifest/dev-instance/
```

The dev instance's control runs `CONTROL_ENV=local` and its TUF repository and licence set are `local` too, so the
image's `whombat.environment` is `local` (a `dev` registration is refused with `wrong_environment`). Self-registration
must be switched on there: `WB_MGD_SELF_REGISTRATION=1` in `~/.config/whombat/stack-dev.env`, then restart
`whombat-stack-dev`.

These are development keys: nothing here may ever reach a prod image (the prod assertions refuse `local` licence
kids; the prod image reads `manifest/prod/` instead, PI-10).

**Fixed problem (2026-09-27, PI-13):** the dev instance's static server used to serve the whole `env/manager/tuf/`
directory, including `keys/` with the private keys. It now serves only metadata, targets and clients
(`https://updates-dev.whombat.com/keys/root-0.json` answers 404), and John rotated the top-level keys (root version 2
above). An image built before this pins root version 1 and should be reinstalled. These remain development keys:
use this image for development boxes only.
