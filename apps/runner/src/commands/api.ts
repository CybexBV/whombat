/**
 * The runner API of the agent's commands (agent-computer.md AC-41, AC-42; one-person.md OP-07, OP-S107; contracts
 * 3.0.0): may a command run (`runner.authorizeCommand`), wait for a person's answer (`runner.authorizeWait`), the turn's
 * Vault keys (`runner.turnKeys`), and a background job's `whombat notify` (`runner.notify`, RA-31).
 */
import {
  type AuthorizeCommandBody,
  type AuthorizeCommandReply,
  type AuthorizeWaitReply,
  type ClassifyContext,
  type CommandClassification,
  classifyCommand,
  type DispatchCommandsContext,
  type DispatchContext,
  type RunnerNotifyBody,
  type TurnKeys,
} from '@whombat/core';
import { createRunnerEndpointCaller } from '../api-transport';

export type {
  AuthorizeCommandBody,
  AuthorizeCommandReply,
  AuthorizeWaitReply,
  CommandClassification,
  CommandOpening,
  RunnerNotifyBody,
  TurnKeys,
} from '@whombat/core';

/** What the commands of a person's turn may reach and what asks first (`DispatchContext.commands`). */
export type CommandsContext = DispatchCommandsContext;

export interface RunnerCommandsApi {
  authorizeCommand(body: AuthorizeCommandBody): Promise<AuthorizeCommandReply>;
  authorizeWait(
    approvalId: string,
    query: { dispatchId: string; attempt: number; runnerId: string; waitMs: number },
    signal?: AbortSignal,
  ): Promise<AuthorizeWaitReply>;
  turnKeys(dispatchId: string, lease: { runnerId: string; attempt: number }): Promise<TurnKeys>;
  notify(body: RunnerNotifyBody): Promise<void>;
}

/** The turn's production servers, home networks and local network: null in an outsiders' turn (OP-17). */
export function commandsContextOf(ctx: DispatchContext): CommandsContext | null {
  return ctx.commands ?? null;
}

/** The guard (AC-40): `classifyCommand` of the contracts. */
export type CommandGuard = (command: string, ctx: ClassifyContext) => CommandClassification | null;
export const commandGuard: CommandGuard = classifyCommand;

/** Over HTTP with the runner token; answers are checked against the contract. */
export function createRunnerCommandsApi(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): RunnerCommandsApi {
  const call = createRunnerEndpointCaller(serverUrl, token, fetchImpl, {
    httpError: (status, _body, message) => Object.assign(new Error(message), { status }),
  });
  return {
    authorizeCommand: (body) => call('authorizeCommand', { params: {}, body }),
    authorizeWait: (approvalId, query, signal) =>
      call('authorizeWait', { params: { approvalId }, query, body: undefined, signal }),
    turnKeys: (dispatchId, lease) =>
      call('turnKeys', { params: { dispatchId }, query: lease, body: undefined }),
    notify: async (body) => {
      await call('notify', { params: {}, body });
    },
  };
}
