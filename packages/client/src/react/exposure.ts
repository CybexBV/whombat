/**
 * Open to the internet (`things.exposure`, Whombat internet-exposure.md): the page's read, asked only of a Whombat that
 * has it, and This is meant, which is Stop watching that one opening's “Something new is open to the internet”
 * (`things.setWatch` on the place whose settings opened it). The row changes at once; the toast offers Undo, and the
 * page, the place's own page, Home and the Inbox are read again after the answer. Works in React DOM and React Native.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ExposureOpening, ExposureView } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { EXPOSURE_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useCallback, useRef, useState } from 'react';
import { withMeant } from '../home/exposure';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useSessionProtocol, useWhombat } from './context';
import { queryHook } from './queries';

const useExposureQuery = queryHook(api.things.exposure);

/** Settings change seldom, and the box keeps each place's read for 10 minutes. */
const EXPOSURE_STALE_MS = 60_000;

/** What the internet can reach; `supported` false on a Whombat too old to say, which is asked nothing. */
export function useExposure(burrow: string) {
  const supported = protocolAtLeast(useSessionProtocol(), EXPOSURE_MINOR);
  const query = useExposureQuery(supported ? { params: { burrow } } : null, {
    retry: false,
    staleTime: EXPOSURE_STALE_MS,
  });
  return { supported, ...query };
}

/** How a press went: the toast's words, Undo when it can be taken back, and whether it failed. */
export type ExposureNote = (message: string, options?: { undo?: () => void; failed?: boolean }) => void;

export interface ExposureMeantWords {
  meantDone: (address: string) => string;
  pointedOut: (address: string) => string;
  failedPress: string;
}

export interface ExposureMeant {
  /** This is meant (`meant` true) or Point it out again (false). */
  set(opening: Pick<ExposureOpening, 'id' | 'watch'>, meant: boolean): void;
  /** Whether a press on this opening is still waiting for the box. */
  busy(id: string): boolean;
}

/** This is meant and Point it out again, with Undo in the toast. */
export function useExposureMeant(
  burrow: string,
  words: ExposureMeantWords,
  note: ExposureNote,
): ExposureMeant {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const ref = useRef({ words, note });
  ref.current = { words, note };

  const press = useCallback(
    async (opening: Pick<ExposureOpening, 'id' | 'watch'>, meant: boolean, toast: boolean) => {
      const { thing, check, subject } = opening.watch;
      setRunning((s) => new Set(s).add(opening.id));
      await qc.cancelQueries({ queryKey: queryKeys.scope('things.exposure', { burrow }) });
      patchEndpoint<ExposureView>(qc, 'things.exposure', (v) => withMeant(v, opening.id, meant), { burrow });
      const putBack = () =>
        patchEndpoint<ExposureView>(qc, 'things.exposure', (v) => withMeant(v, opening.id, !meant), {
          burrow,
        });
      try {
        const result = await client.request(api.things.setWatch, {
          params: { burrow, thing },
          body: { check, subject, watched: !meant },
        });
        if (result.status !== 'ok') {
          putBack();
          ref.current.note(commitOutcomeText(result) ?? ref.current.words.failedPress, { failed: true });
        } else if (toast) {
          const w = ref.current.words;
          ref.current.note(
            meant ? w.meantDone(subject.name) : w.pointedOut(subject.name),
            meant ? { undo: () => void press(opening, false, false) } : undefined,
          );
        }
      } catch (error) {
        putBack();
        ref.current.note(hostErrorInfo(error).message || ref.current.words.failedPress, { failed: true });
      } finally {
        setRunning((s) => {
          const next = new Set(s);
          next.delete(opening.id);
          return next;
        });
        for (const [endpoint, params] of [
          ['things.exposure', { burrow }],
          ['things.page', { burrow, thing }],
          ['things.watch', { burrow, thing }],
          ['home.overview', { burrow }],
          ['watch.list', { burrow }],
        ] as const)
          void qc.invalidateQueries({ queryKey: queryKeys.scope(endpoint, params) });
      }
    },
    [client, qc, burrow],
  );

  const set = useCallback(
    (opening: Pick<ExposureOpening, 'id' | 'watch'>, meant: boolean) => void press(opening, meant, true),
    [press],
  );
  const busy = useCallback((id: string) => running.has(id), [running]);
  return { set, busy };
}
