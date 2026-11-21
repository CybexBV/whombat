/**
 * What Whombat adds to a tool's description as its MCP server serves it, beyond the contract's words (which stay as they
 * are): the rule where the tool is (docs/decisions/hermes-engine.md HE-34, HE-S37). These were lines of the old persona
 * prompt; Hermes composes the prompt now, and every engine reads a tool's description where it decides to call it. A
 * description is resent on every model call of a turn that is served the tool, so an addition is a sentence or two.
 *
 * - `schedule`: never to wait for checks or CI (health-checks-wake.md HW-08), nor for a T3 Code thread (t3code.md).
 * - `start_run`, `finish_run`, `open_pull_request`: runs (run-checkout.md RC-01, RC-11, RC-15; health-run-start.md HRS-05;
 *   run-line.md RL-01; RN-R5). `NO_REPLY` is the runner's final text that is never posted (`persona/prompt.ts`).
 * - `record_deploy`, `perform_action`: what is deployed and how (agent-efficiency.md AE-09; runs-approvals.md MDS-06).
 * - `request_approval`: keys by their label (key-requests.md), restarts at night (one-whombat.md).
 * - `search`: search first, recall before asking again (resourceful-agents.md RA-26).
 * - `plan_create`: one-whombat.md.
 * - `draft_automation`: ask only what changes what runs (automation-chat.md).
 * - `connection_call`: a reading never decides what is possible (task-feedback.md TF-03).
 * - `device_probe`: what exists first, and the honest answer (one-whombat.md ONE-17, ONE-19).
 */
import type { McpToolName } from '@whombat/core';

export const ADDED_DESCRIPTIONS: Readonly<Partial<Record<McpToolName, string>>> = {
  schedule:
    'Not to wait for checks or CI, or for a T3 Code thread: when the checks on a pull request you work on finish, Whombat wakes you in the run’s thread with the result, and when a T3 Code thread you handed work to finishes or asks something, in the thread you handed it over in. Schedule only what time alone brings.',
  start_run:
    'For code work not sent to T3 Code. With no checkout in this turn, call it first, before you read a file or reply, then end the turn with only NO_REPLY: the run shows in the thread as a live line, and you carry on in it, in a checkout of its branch. In an automation’s step, start one only when the request asks.',
  finish_run:
    'Report as you go with run_step, run_log, run_tests and run_files. Don’t finish a run whose rest waits on a person (ask them once with asks: true and leave it live), on its pull request’s checks (Whombat wakes you when they finish) or on something slow (schedule a turn).',
  open_pull_request:
    'In an automation’s step, open one only when the request asks for it; otherwise commit, and the automation takes it from there.',
  record_deploy:
    'Deploy a build of the repository (its merged default branch, or a branch a person asked to deploy), never your change layered onto a server’s files: what the server has and the repository lacks goes into the repository first.',
  perform_action:
    'A deploy here runs the repository’s deploy workflow, only when Whombat has one; otherwise deploy the way the project does it.',
  request_approval:
    'Name keys by their label in curly quotes (“Browse the web”), never by their id, and never offer quick replies that pretend to give you one. Changes that interrupt something (a restart, an update) usually belong at night: say so when you ask.',
  search:
    'Search before you answer from what is on this Whombat, and before you ask someone to repeat earlier work (“like last time”). Never cite what you didn’t read.',
  plan_create: 'Keep its steps current with plan_update as you go: the person follows it in the thread.',
  draft_automation:
    'Ask first only what changes what runs and you can’t decide: which repository or connection, how often, whether it may act outside Chat. One short question at a time, with quick replies; pick the rest and name it in thinking. Fixing, merging and replying to customers only when asked.',
  connection_call:
    'What a tool read earlier never decides what you can do: try the action, it asks or refuses in plain words. When a person says a setting is on, check again.',
  device_probe:
    'Before you learn a device, look for what exists (a Home Assistant integration, a catalog connection). Say plainly when a unit can’t be read: cloud-only, extra hardware needed, or no documented registers or API.',
};

/** A tool's description as served: the contract's, then Whombat's addition when it has one. */
export function servedToolDescription(name: string, description: string): string {
  const added = ADDED_DESCRIPTIONS[name as McpToolName];
  return added ? `${description} ${added}` : description;
}
