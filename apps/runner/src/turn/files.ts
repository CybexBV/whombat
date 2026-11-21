/**
 * The files a turn finds: the conversation's Files (files-space.md FS-09, FS-10) — read-only at ~/files for a person's
 * commands (one-person.md OP-S109), or told how to reach them — and the dispatch's attachments as its provider can take
 * them (attachments.ts).
 */

import { type AgentProvider, FILES_IN_HOME, filesTurnLines, planTurnFiles } from '@whombat/agent-runtime';
import { prepareTurnFiles } from '../attachments';
import { commandsContextOf } from '../commands/api';
import { prepareConversationFiles } from '../files';
import { filesCacheOf } from './deps';
import type { BuiltTurn } from './input';
import type { TurnScope } from './scope';
import type { TurnShape } from './shape';

/** Where the conversation's Files are laid out for the turn, if anywhere: `~/files` of the agent's home. */
export type FilesPlace = 'home' | null;

export async function placeFiles(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'stop' | 'resources'>,
  plan: {
    built: BuiltTurn;
    shape: TurnShape;
    provider: AgentProvider;
    step: (name: string) => void;
  },
): Promise<FilesPlace> {
  const { ctx, deps, stop, resources } = turn;
  const { built, shape } = plan;
  // Read-only at ~/files for a person's commands (the same condition as their commands, `openSandbox`); any other turn
  // is told how to reach them.
  const filesWhere: FilesPlace =
    shape.commandsTurn && deps.commands && deps.pods && commandsContextOf(shape.ctx) ? 'home' : null;
  if (filesWhere)
    resources.conversationFiles = await prepareConversationFiles(
      ctx,
      { api: deps.api, cache: filesCacheOf(deps), workspacesRoot: deps.workspacesRoot, log: deps.log },
      stop.signal,
    );
  const conversationFiles = resources.conversationFiles;
  const files = conversationFiles?.plan ?? planTurnFiles(ctx.files);
  const placed = conversationFiles
    ? {
        count: conversationFiles.paths.size,
        bytes: conversationFiles.bytes,
        unavailable: conversationFiles.unavailable,
      }
    : filesWhere
      ? { count: 0, bytes: 0, unavailable: files?.included ?? [] }
      : null;
  const lines = filesTurnLines(files, filesWhere, placed);
  if (lines.length) built.input.prompt += `\n${lines.join('\n')}`;

  // The dispatch's attachments, as this provider can take them (attachments.ts); a person's turn finds one that is in
  // the conversation's Files at ~/files (FS-10).
  resources.turnFiles = await prepareTurnFiles(
    ctx,
    { ...deps, filesCache: filesCacheOf(deps) },
    plan.provider.capabilities(),
    stop.signal,
    new Map([...(conversationFiles?.paths ?? [])].map(([id, rel]) => [id, `${FILES_IN_HOME}/${rel}`])),
  );
  plan.step('files');
  const { turnFiles } = resources;
  if (turnFiles?.attachments.length) built.input.attachments = turnFiles.attachments;
  if (turnFiles?.section) built.input.prompt += `\n${turnFiles.section}`;
  return filesWhere;
}
