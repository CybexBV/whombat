# DEVELOPMENT PRIVATE KEYS — NEVER USE FOR A REAL RELEASE

These are the **private** TUF signing keys (root, targets, snapshot, timestamp) and the control assignment
key of the development fixture repository `../dev/repo`. They are committed on purpose so tests and VM
tests can sign development metadata and assignments. Anyone who reads this repository has them.

- They live outside `../dev/`, which the VM tests serve over HTTP.
- Every file carries `"development": true`; `devtuf.Load` refuses keys without it.
- A production device refuses any TUF root that trusts one of these keys: the NixOS build asserts it for
  `whombat.environment = "prod"` (`nix/modules/manager.nix`), and the manager and the update helper refuse
  such a root at runtime (`trust.DevelopmentKeyIDs`, W4-SEC part 2 L-4).
- Regenerating the fixtures (`release-tools/fixtures/README.md`) replaces them; add the new ids to
  `helper/pkg/trust/devroot.go` (the test `TestDevelopmentKeyIDsMatchFixtures` fails until you do) and keep the
  old ones: those private keys stay readable in the history.
