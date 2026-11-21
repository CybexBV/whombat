import { type YouPart, youParts } from '@whombat/client';
import { useMemo } from 'react';
import { useAppServices } from '../../app/providers';
import { usePrompts } from '../prompts/usePrompts';

/**
 * You's parts as they show here: Devices and Shared links on a box, and Prompts unless the Whombat doesn't have them
 * (`unknown_op`; it shows while the list is still being asked, so nothing jumps on a box that has them).
 */
export function useYouParts(burrow: string): YouPart[] {
  const { managed } = useAppServices();
  const prompts = usePrompts(burrow);
  const without = prompts.known && !prompts.available;
  return useMemo(
    () => youParts({ managed: managed !== null }).filter((p) => p !== 'prompts' || !without),
    [managed, without],
  );
}
