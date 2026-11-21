/**
 * The assistant's Memory (Whombat hermes-engine.md HE-39; the web's Memory part): what it remembers about you (`MemoryFiles`)
 * and the notes it reads in every chat (`NotesSection`), in one place. Pulling down reads both again.
 */
import { useAgentNotes, useMyMemory } from '@whombat/client/react';
import { useBurrowBase } from '../../data/BurrowProvider';
import { MemoryFiles } from '../MemoryScreen';
import { NotesSection } from './NotesSection';
import { type PartProps, PartScroll } from './parts';

export function MemoryPart({ profile }: PartProps) {
  const { slug } = useBurrowBase();
  const memory = useMyMemory({ params: { burrow: slug } });
  const notes = useAgentNotes({ params: { burrow: slug } });
  return (
    <PartScroll
      refreshing={memory.isRefetching || notes.isRefetching}
      onRefresh={() => {
        void memory.refetch();
        void notes.refetch();
      }}
    >
      <MemoryFiles />
      <NotesSection profile={profile} />
    </PartScroll>
  );
}
