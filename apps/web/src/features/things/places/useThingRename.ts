/**
 * Renaming a server or connection where it is listed (server-names.md): which row is being renamed, and the name just
 * saved until the list says it too. Used by the Servers and Connections lists (servers-connections-places.md).
 */
import type { ThingRenameTarget } from '@whombat/client';
import { useRenameThing } from '@whombat/client/react';
import { useEffect, useState } from 'react';

export interface ThingRenaming {
  editing: string | null;
  start: (thingId: string) => void;
  stop: () => void;
  save: (target: ThingRenameTarget, typed: string) => Promise<string | null>;
  /** The name a row shows while the list catches up with a rename, or null. */
  shown: (row: { id: string; name: string }) => string | null;
}

export function useThingRename(burrow: string): ThingRenaming {
  const { rename } = useRenameThing(burrow);
  const [editing, setEditing] = useState<string | null>(null);
  // The name saved per row, with the name the list said then: it shows until the list says something else.
  const [saved, setSaved] = useState<ReadonlyMap<string, { name: string; was: string }>>(new Map());
  useEffect(() => {
    if (!saved.size) return;
    const timer = setTimeout(() => setSaved(new Map()), 10_000);
    return () => clearTimeout(timer);
  }, [saved]);
  return {
    editing,
    start: setEditing,
    stop: () => setEditing(null),
    save: async (target, typed) => {
      const thingId = `${target.kind}:${target.id}`;
      const outcome = await rename(target, typed);
      if (!outcome.ok) return outcome.problem;
      if (outcome.changed) {
        const name = typed.trim().replace(/\s+/g, ' ') || target.id;
        setSaved((m) => new Map(m).set(thingId, { name, was: target.name }));
      }
      return null;
    },
    shown: (row) => {
      const s = saved.get(row.id);
      return s && row.name === s.was ? s.name : null;
    },
  };
}
