/**
 * A field inside a chat list's row kept clear of the keyboard: the list (`ChatView`) provides `reveal`, a form
 * in a row (a feature request's reason or question) calls it with its view when its field gets the cursor, and the list
 * scrolls just enough once the keyboard is up (`revealBy`). The composer sits under the list, so it needs none; outside
 * such a list there is nothing to scroll (null).
 */
import { createContext, useContext } from 'react';
import type { View } from 'react-native';

export type RevealInList = (node: View | null) => void;

export const RevealInListContext = createContext<RevealInList | null>(null);

export function useRevealInList(): RevealInList | null {
  return useContext(RevealInListContext);
}
