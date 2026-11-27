import type { MessageCatalog } from '@whombat/core/i18n';
import { ASKS_AREA_WORDS } from './asks';
import { AUTOMATIONS_AREA_WORDS } from './automations';
import { CARDS_AREA_WORDS } from './cards';
import { CHAT_AREA_WORDS } from './chat';
import { HOME_AREA_WORDS } from './home';
import { SETTINGS_AREA_WORDS } from './settings';
import { SKILLS_AREA_WORDS } from './skills';
import { WORK_AREA_WORDS } from './work';

export type MessageArea = {
  readonly en: MessageCatalog;
  readonly nl: MessageCatalog;
  readonly prefix: string;
};

/** The word trees of Chat and the work it holds (cards, jobs, runs, prompts, automations, settings, home). */
export const CHAT_WORK_AREAS: readonly MessageArea[] = [
  CHAT_AREA_WORDS,
  CARDS_AREA_WORDS,
  WORK_AREA_WORDS,
  ASKS_AREA_WORDS,
  AUTOMATIONS_AREA_WORDS,
  SETTINGS_AREA_WORDS,
  SKILLS_AREA_WORDS,
  HOME_AREA_WORDS,
];
