/**
 * The shared words of `@whombat/core` and `@whombat/client` in the page's language, for components: each hook is the
 * package's own `…Words(locale)` / `…Text(locale)`, kept until the language changes.
 */
import {
  agentWords,
  needsYouWords,
  overviewWords,
  settingsGroupText,
  settingsHomeText,
  themeWords,
  usageText,
} from '@whombat/client';
import { agentUpdateWords } from '@whombat/client/hosts';
import { connectAiText } from '@whombat/client/managed';
import { useMemo } from 'react';
import { useWebI18n } from './provider';

/** Any `…Words(locale)` of the shared packages in the page's language, built again only when it changes. */
export function useLocaleWords<T>(make: (tag?: string) => T): T {
  const { tag } = useWebI18n();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each caller passes a module-level function.
  return useMemo(() => make(tag), [tag]);
}

export const useNeedsYouWords = () => useLocaleWords(needsYouWords);
export const useOverviewWords = () => useLocaleWords(overviewWords);
export const useSettingsGroupText = () => useLocaleWords(settingsGroupText);
export const useSettingsHomeText = () => useLocaleWords(settingsHomeText);
export const useThemeWords = () => useLocaleWords(themeWords);
export const useUsageText = () => useLocaleWords(usageText);
export const useConnectAiText = () => useLocaleWords(connectAiText);
export const useAgentUpdateWords = () => useLocaleWords(agentUpdateWords);

/** The assistant's name forms (`Name`, `name`, `NAME`) with the fallback name in the page's language. */
export function useAgentWords(name: string | null | undefined) {
  const { tag } = useWebI18n();
  return useMemo(() => agentWords(name, tag), [name, tag]);
}
