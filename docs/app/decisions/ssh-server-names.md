# SSH server names (2026-10-09)

John, 2026-10-09: “Add server” refused `PVE-01` with “Use 1–40 lowercase letters …” — “it's a name, not a hostname
or username”.

| ID | Decision | Why |
|----|----------|-----|
| AP-949 | **A server's name may hold capitals** (contracts 0.64.2, CT-319; Whombat VT-D61). The form checks with the contracts' `AddVaultSshServerBody` as before, so `PVE-01` passes and the field's words read “Use 1–40 letters, digits, dots, dashes and underscores, starting with a letter or digit.”; spaces stay refused (agents type the name, and `ssh PVE-01` on their computers). A name that differs from another of the key's only in case is the server's “This key already has a server with that name.”, shown under Name. Android shows servers read-only: nothing to change. | The form had no rule of its own to change: the contract is the one place. |
