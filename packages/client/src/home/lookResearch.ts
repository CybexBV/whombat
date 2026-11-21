/**
 * What the assistant found out about a look (Whombat look-research.md LR-01…LR-12; contracts 3.5 `LookResearch`; app
 * look-research-web.md AP-5900…): which words and buttons Home's Needs you, a thing's page and Settings → Screen's
 * preview draw for it, what Ask {assistant} opens, and the screens the moment the step is pressed (the server's answer
 * then takes over). The same story everywhere: while it looks, the look as before with “I’m looking into it.”; once
 * it found out, its title and summary, the step it offers first, Ignore, Ask {assistant}; “I’m on it.” while it takes
 * the step; green with its words once fixed. Without research, or `failed`, everything stays as it was. Pure; web and
 * phone share it.
 */
import {
  chatThreadHref,
  DESK_WORDS,
  type DeskHero,
  fillDeskWords,
  type HomeOverview,
  type LookResearch,
  type ThingPage,
} from '@whombat/core';

const W = DESK_WORDS.looks;

/** Where the research is, as a screen draws it; `failed` draws as no research. */
export type LookResearchShown = Exclude<LookResearch['state'], 'failed'>;

export interface LookResearchView {
  state: LookResearchShown;
  /** The assistant's title (“Zigbee stopped working in Home Assistant”), or null to keep the look's own. */
  title: string | null;
  /**
   * The line beside the assistant's face: “I’m looking into it.” (with the reason so far when the screen gives one),
   * its summary, or “I’m on it.”.
   */
  text: string;
  /** A spinner before `text`: it is working on it (looking, fixing). */
  busy: boolean;
  /** Green: it fixed it and saw it work (LR-09). */
  fixed: boolean;
  /** The step's button (“Restart Zigbee”), the first one: only once it found out and offers one. */
  fix: string | null;
  /** Ignore: offered until it is fixed. */
  ignore: boolean;
  /** “Ask Neo”: once it said what is wrong, it opens the look's thread. */
  ask: string | null;
}

/** The reason without its last full stop, for “So far: {reason}.” */
function bare(reason: string): string {
  return reason.trim().replace(/[.。]+$/, '');
}

/**
 * What a screen draws for a look's research (LR-09), or null to draw the look as before (none, or `failed`). `reason`
 * is what Whombat already knows, for “I’m looking into it. So far: …” on a screen that shows nothing else while it
 * looks; without it the look's own words stay and the line says “I’m looking into it.” only.
 */
export function lookResearchView(
  research: LookResearch | null | undefined,
  assistant: string,
  reason?: string | null,
): LookResearchView | null {
  if (!research || research.state === 'failed') return null;
  const ask = fillDeskWords(W.ask, { assistant });
  switch (research.state) {
    case 'looking': {
      const so = reason ? bare(reason) : '';
      return {
        state: 'looking',
        title: null,
        text: so ? fillDeskWords(W.lookingSoFar, { reason: so }) : W.looking,
        busy: true,
        fixed: false,
        fix: null,
        ignore: true,
        ask: null,
      };
    }
    case 'found':
      return {
        state: 'found',
        title: research.title ?? null,
        text: research.summary ?? '',
        busy: false,
        fixed: false,
        fix: research.fix ?? null,
        ignore: true,
        ask,
      };
    case 'fixing':
      return {
        state: 'fixing',
        title: research.title ?? null,
        text: W.fixing,
        busy: true,
        fixed: false,
        fix: null,
        ignore: true,
        ask,
      };
    case 'fixed':
      return {
        state: 'fixed',
        title: research.title ?? null,
        text: research.summary ?? '',
        busy: false,
        fixed: true,
        fix: null,
        ignore: false,
        ask,
      };
  }
}

/** The look's thread in the person's Chat (LR-04), which Ask {assistant} opens; null when the research has none. */
export function lookThreadHref(research: Pick<LookResearch, 'threadRootId'>): string | null {
  return research.threadRootId ? chatThreadHref('chat', research.threadRootId) : null;
}

/* The step's press (LR-08) ------------------------------------------------------------------------------------------- */

/** How the step's press went, in a short toast when it didn't (the card itself says “I’m on it.”). */
export const LOOK_FIX_WORDS = {
  /** 403: the person may not manage the thing. */
  forbidden: 'You can’t change this.',
  /** 404: the look went, or it offers no step any more. */
  gone: 'That isn’t needed any more.',
  failed: 'That didn’t work. Try again in a moment.',
} as const;

/** How a press went: through (`ok`), not the person's to take (`forbidden`), no step any more (`gone`), or not. */
export type LookFixOutcome = 'ok' | 'forbidden' | 'gone' | 'failed';

/** What the step's press answered with, as its toast (null: it went through, the card says so). */
export function lookFixOutcomeText(outcome: LookFixOutcome): string | null {
  return outcome === 'ok' ? null : LOOK_FIX_WORDS[outcome];
}

/** The research as it is the moment the step is pressed: `fixing`, the step gone. */
export function fixingResearch(research: LookResearch, now: number): LookResearch {
  const { fix: _fix, ...rest } = research;
  return { ...rest, state: 'fixing', at: new Date(now).toISOString() };
}

/** Home with `research` on the items of its look (by key); the same overview when none has it. */
export function withNeedsYouResearch<T extends Pick<HomeOverview, 'needsYou'>>(
  overview: T,
  research: LookResearch,
): T {
  if (!overview.needsYou.some((i) => i.research?.key === research.key)) return overview;
  return {
    ...overview,
    needsYou: overview.needsYou.map((i) => (i.research?.key === research.key ? { ...i, research } : i)),
  };
}

/**
 * A thing's page with `research` when it is the page's look (or the page's own thing, when the person just handed it
 * to the assistant); the same page otherwise.
 */
export function withThingResearch(page: ThingPage, research: LookResearch): ThingPage {
  return page.research?.key === research.key || (!page.research && page.id === research.key)
    ? { ...page, research }
    : page;
}

/* Settings → Screen's preview: the hero's buttons (DK-113, LR-09, LR-10) ------------------------------------------------ */

export interface DeskHeroButton {
  label: string;
  /** `primary` filled, `outline` with a line, `quiet` words only. */
  look: 'primary' | 'outline' | 'quiet';
}

/**
 * The calm hero's buttons as the screen draws them, for the preview's picture of it: *Answer* on a question; on a look
 * the step the assistant offers first (`fix`, only once it found out), *Ask {assistant} to look into it* on a down server
 * it hasn't looked into (it asks; it doesn't promise a fix), *Open {server}*, and Ignore where *Not now* was (LR-10). Nothing to ignore once it is fixed.
 * `server` is the name the strip shows for the hero's server.
 */
export function deskHeroButtons(
  hero: Pick<DeskHero, 'kind' | 'tone' | 'research' | 'fix'>,
  words: { assistant: string; server: string | null },
): DeskHeroButton[] {
  const C = DESK_WORDS.calm;
  if (hero.kind === 'ask') return [{ label: C.answer, look: 'primary' }];
  const research = hero.research === 'failed' ? undefined : hero.research;
  const buttons: DeskHeroButton[] = [];
  if (research === 'found' && hero.fix) buttons.push({ label: hero.fix, look: 'primary' });
  else if (!research && hero.tone === 'bad')
    buttons.push({
      label: fillDeskWords(DESK_WORDS.looks.fix, { assistant: words.assistant }),
      look: 'primary',
    });
  if (words.server)
    buttons.push({
      label: fillDeskWords(C.open, { name: words.server }),
      look: buttons.length ? 'outline' : 'primary',
    });
  if (research !== 'fixed') buttons.push({ label: C.ignore, look: 'quiet' });
  return buttons;
}
