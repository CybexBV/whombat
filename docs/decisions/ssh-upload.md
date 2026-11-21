# Copying a build to a server: `ssh_upload` (SU-01…SU-03)

John on DEV (2026-10-03), after Banjo merged the website's PR #2 but couldn't publish it: “It has access to the
production server where the website is published, I would like Banjo to find out where the website files are and
figure out itself how to publish it. It has full root access to the server via the vault keys.” Banjo could run any
command there (`ssh_exec`) but had no way to move its build onto the server: the dev stack's agents have no computer
(agent-computer.md AC-23), the repo is private (the server can't fetch it) and `ssh_write_file` takes content the
agent types itself (`dist/` is 39 files, 842 KB).

| ID | Decision | Why |
| --- | --- | --- |
| SU-01 | **`ssh_upload {entry, server, from, to}` copies a folder of the turn's working directory into a folder on a server** (contracts 0.42.0, CT-244). Decided like `ssh_write_file` (use kind `ssh`: the agent's key, the owner's pass, the server covered and ready), recorded as “upload dist → web-1:/var/www/site/releases/r2”. The folder is read by the turn's runner exactly as for `browser_preview` (BT-48: inside the working directory, symlinks and `.git` skipped, at most 2 000 files and 50 MB) through the same `PreviewBroker`; Whombat writes it over one SFTP session, making `to` and each file's folders when missing and replacing files with the same names. Nothing is written when the runner can't send the folder; a server refusal answers `file_error`. Up to five minutes for the writes. | The smallest step that lets an agent without a computer publish a build. It adds no power: an agent holding the key already runs any command there. |
| SU-02 | **Deploying with it is the Deploy row's.** A turn without a computer whose agent holds an SSH key says, under Deploy On: build, `ssh_upload` into a new folder beside the live one, switch with `ssh_exec` the way the server already does it, check, keep the previous one; under Ask: first ask with `request_approval`, saying what it will copy and switch; Off: nothing. The Vault's own rules (VAULT_SSH_AGENT_RULES, VAULT_ACCESS_RULES) name `ssh_upload`. | The agent should find the way the server is set up (release folders, a symlink) and follow it, as John asked. |
| SU-03 | **Merge On's line follows MOA-02**: “once its checks pass and, when anyone else could review it, a review approves”. | It still told Banjo a review was always needed. |

*Amended 2026-10-04 (resourceful-agents.md RA-DS60, RA-DS61): the SSH deploy lines build and check in the agent's own
folder, ssh_upload the built output, switch with one ssh_exec and never patch or build on the server; they also reach a
computer turn whose key Whombat uses; an agent holding no SSH key gets their keyless form (ask for one when the goal
needs a deploy).*

*Amended 2026-10-04 (resourceful-agents.md RA-DS70, RA-DS71): a computer turn without a checkout — a conversation
included — reads `from` in the agent's work folder (`~/work`); the folder is read without following a link, also while
the computer changes it.*
