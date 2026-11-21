/**
 * `useThingRename`: which row is being renamed on a list (or a page's title), the save, and the names just saved, so
 * a row shows its new name at once and not its old one again until the list says the new one too.
 */
import type { ThingRenameTarget } from '@whombat/client';
import { useRenameThing } from '@whombat/client/react';
import { useCallback, useEffect, useState } from 'react';
import { RENAME_COPY, SAVED_NAME_MS, type SavedNames, savedName, shownName } from './rename';

export interface ThingRenaming {
  /** The thing id (`server:the-titan`) whose name is a box now, or null. */
  editing: string | null;
  start: (thingId: string) => void;
  stop: () => void;
  /** Saves what was typed: why it can't be used (the box stays), or null when it went or nothing changed. */
  save: (target: ThingRenameTarget, typed: string) => Promise<string | null>;
  /** The name a row shows: the one just saved while `listName` is still the one before it. */
  shown: (thingId: string, listName: string) => string;
}

export function useThingRename(burrow: string): ThingRenaming {
  const { rename } = useRenameThing(burrow);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedNames>(new Map());
  useEffect(() => {
    if (!saved.size) return;
    const timer = setTimeout(() => setSaved(new Map()), SAVED_NAME_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  const stop = useCallback(() => setEditing(null), []);
  const save = useCallback(
    async (target: ThingRenameTarget, typed: string) => {
      const outcome = await rename(target, typed).catch(() => ({
        ok: false as const,
        problem: RENAME_COPY.failed,
      }));
      if (!outcome.ok) return outcome.problem;
      const name = outcome.changed ? savedName(target, typed) : null;
      if (name) setSaved((m) => new Map(m).set(`${target.kind}:${target.id}`, { name, was: target.name }));
      return null;
    },
    [rename],
  );
  const shown = useCallback(
    (thingId: string, listName: string) => shownName(saved, thingId, listName),
    [saved],
  );
  return { editing, start: setEditing, stop, save, shown };
}
