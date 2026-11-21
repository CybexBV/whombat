import { useEffect } from 'react';

/**
 * Keeps the chosen part in view in a parts control that scrolls sideways (a phone's width): the control with
 * `className` scrolls its checked segment into view whenever `value` changes, as Settings' tab row does.
 */
export function usePartInView(className: string, value: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: another chosen part is what moves the control
  useEffect(() => {
    for (const input of document.querySelectorAll<HTMLInputElement>(
      `.${CSS.escape(className)} input:checked`,
    ))
      input.closest('label')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [className, value]);
}
