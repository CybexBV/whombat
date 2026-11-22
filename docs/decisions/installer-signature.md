# A signed checksum for the installer

The installer ISO and its `.sha256` file come from the same download site (`appliance/release/upload-iso`). The
checksum shows that a download arrived whole; it can't show that the ISO is Whombat's, because whoever could swap the
ISO could swap the checksum next to it. A Whombat checks the signatures of its own updates, but a person who installs
from a changed ISO gets a box that trusts whatever that ISO put in it.

| # | Decision | Why |
|---|---|---|
| ISG-01 | **The download text says what the checksum is for.** Until the installer's checksum is signed, the README and the install runbook call `sha256sum -c` a check that the download arrived whole, not proof that it is Whombat's. | Honest about what a person can check today. |
| ISG-02 | **The checksum is signed with the project's release key, in the format runtime bundles already use** (`bp-distribution.md` BP-F20): `whombat-installer.iso.sha256.sig` is the raw 64-byte Ed25519 signature of the exact bytes of `whombat-installer.iso.sha256`, uploaded beside it (`installer/<id>/` and `installer/latest/`), and `latest.json` names it (`sigUrl`, `latestSigUrl`). Anyone checks it with OpenSSL against the public key published in this repository (GitHub, not the download site): `openssl pkeyutl -verify -pubin -inkey whombat-release.pub.pem -rawin -in whombat-installer.iso.sha256 -sigfile whombat-installer.iso.sha256.sig`, then `sha256sum -c`. | One key and one format for everything people download; OpenSSL is on every machine that can write a USB stick; the public key lives on a different host from the files it vouches for. |
| ISG-03 | **No TUF entry for the installer.** The update repository's channel roles could list the ISO's hash, but a person has no TUF client, and the ISO is built after its release is published, so listing it would mean signing the channel role again at the upload. | Not something a person can check by hand; more moving parts than a signature. |
| ISG-04 | **The key is made in a key ceremony, not by a helper.** The project's release key doesn't exist yet (`apps/cli/src/release/keys.ts` is empty). Making it is the maintainers' step: where it lives (offline with John, or online with the release tools beside the production update key), its public key in `keys.ts` and as `whombat-release.pub.pem` in the repository, then `upload-iso --sign-key <file>` signs at every upload and the download page and README show the OpenSSL line. Until then nothing is signed and ISG-01 holds. | A long-lived signing key on The Dragon is John's decision, not an agent's. |
