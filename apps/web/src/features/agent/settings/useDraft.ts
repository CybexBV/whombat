import { useCallback, useEffect, useRef, useState } from 'react';
import { sameDraft } from './model';

/**
 * A tab's form (AP-384): `base` is what the agent holds as last read or saved, `draft` what the person edits. While
 * nothing is changed the form follows the agent (a status report, a change from another device); once something is, later
 * reads leave the edits alone (the modal's “seed once” rule), until Save or Discard.
 */
export function useDraft<T>(seed: T | null) {
  const [base, setBase] = useState<T | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const dirty = base !== null && draft !== null && !sameDraft(base, draft);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const seedKey = seed === null ? null : JSON.stringify(seed);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the seed's JSON
  useEffect(() => {
    const next = seedRef.current;
    if (next === null || dirtyRef.current) return;
    setBase(next);
    setDraft(next);
  }, [seedKey]);

  const discard = useCallback(() => setDraft(base), [base]);
  /** What was saved becomes the base; a partial save passes only the parts that went through. */
  const saved = useCallback((update: (prev: T) => T) => setBase((b) => (b === null ? b : update(b))), []);
  const edit = useCallback((update: (prev: T) => T) => setDraft((d) => (d === null ? d : update(d))), []);
  return { base, draft, dirty, edit, discard, saved };
}
