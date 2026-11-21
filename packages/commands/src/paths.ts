/**
 * The scripts of the agent's commands (docs/decisions/one-person.md OP-07, OP-S105…): next to this module in the
 * repository, next to the bundle in a release (`app/<name>`, scripts/package APP_FILES). Every one runs on the
 * sandbox's pinned Node with built-in modules and its neighbours here only (`frames.mjs`, `line-client.mjs`); the pod and
 * every command see this folder read-only.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hermes's terminal environment's prefix (`whombat-command`): asks the runner, then runs one command in its wrapper. */
export const COMMAND_LAUNCHER_PATH = fileURLToPath(new URL('./whombat-command.mjs', import.meta.url));
/** What starts the commands' holder and runs Whombat's own commands beside the agent's (pod-init, task sandboxes). */
export const COMMANDS_HOST_PATH = fileURLToPath(new URL('./commands-host.mjs', import.meta.url));
/** A task sandbox's payload (outsiders' turns, assessments): the holder, then Hermes. */
export const COMMANDS_INIT_PATH = fileURLToPath(new URL('./commands-init.mjs', import.meta.url));
/** The holder's payload: the commands' network namespace, bridged to the proxy. */
export const COMMANDS_NET_PATH = fileURLToPath(new URL('./commands-net.mjs', import.meta.url));
/** The stand-in `gh` (agent-gh.md AGH-02). */
export const GH_STANDIN_PATH = fileURLToPath(new URL('./whombat-gh.mjs', import.meta.url));
/** git's GitHub transport (`git-remote-whombat`, resourceful-agents.md RA-DS72). */
export const GIT_HELPER_PATH = fileURLToPath(new URL('./whombat-git.mjs', import.meta.url));
/** The `whombat` helper (RA-31: `notify`, `status`). */
export const HELPER_PATH = fileURLToPath(new URL('./whombat-helper.mjs', import.meta.url));
/** `whombat-connect <host> <port>`: a TCP connection through the commands' proxy (ssh's `ProxyCommand`). */
export const CONNECT_PATH = fileURLToPath(new URL('./whombat-connect.mjs', import.meta.url));
/** `whombat-askpass`: ssh's askpass for a server whose password the person kept (vault-simplify.md VLT-42). */
export const ASKPASS_PATH = fileURLToPath(new URL('./whombat-askpass.mjs', import.meta.url));
/** This folder: the pod, the holder and every command bind it read-only. */
export const COMMANDS_DIR = dirname(COMMAND_LAUNCHER_PATH);
