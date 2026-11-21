# A Vault yes for the task (AP-677)

John on DEV (2026-10-03): one Vault card per turn made a single job ask again and again; re-think it the way Hermes
Agent works (Whombat `docs/decisions/goal-first.md` GF-05, contracts CT-245).

## AP-677 The Vault card offers “Allow for one turn” and “Allow for this task”

Contracts 0.43.0 gives a `vault_use` approval `scopeChoices` (`once`, `task`). The web card and the approval modal
(`ApprovalCard`, `ApprovalDetails`) and Android's approval screen already draw a choice row for any approval that has
them (the `run_command` row, AP-623), so a Vault card now shows both buttons and sends `approvals.decide` with the scope;
“Don't allow” stays. The modal keeps a Vault use's WHAT HAPPENS with the choices (only a command's is replaced by its
COMMAND block). The cards gallery gains `approval-vault`. Checked in both themes at the channel column width.
Contracts move from 0.40.1 to 0.43.0 (0.41.0 gh, 0.42.0 ssh_upload: nothing the app draws).
