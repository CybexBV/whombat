import { useQueryClient } from '@tanstack/react-query';
import { BrandMark } from '@whombat/brand/react';
import { type AppPlace, agentFaceOf, appPath, SEARCH_WORDS } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import {
  useApiMutation,
  useBootstrap,
  useChats,
  useHomeOverview,
  useSearchPages,
  useTheAgent,
  useWhombat,
} from '@whombat/client/react';
import {
  type AnswerAction,
  api,
  type Principal,
  SEARCH_FILTER_LABELS,
  SEARCH_FILTERS,
  type SearchAnswer,
  type SearchFilter,
} from '@whombat/core';
import {
  Bot,
  Box,
  ChartNoAxesColumn,
  ChevronRight,
  Folder,
  Inbox,
  LayoutGrid,
  Lock,
  type LucideIcon,
  MessageCircle,
  Plug,
  Search as SearchIcon,
  Settings,
  SlidersHorizontal,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button, IconButton } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { useToast } from '../../components/Toast';
import { viewerTimeZone } from '../messaging/model';
import { useDeveloperTools } from '../settings/useDeveloperTools';
import { THING_ICONS } from '../things/thingIcons';
import { AnswerCard, AskCard } from './AnswerCard';
import { SearchResultRow } from './SearchResultRow';
import styles from './SearchScreen.module.css';
import {
  type CatalogEntry,
  type CatalogGroup,
  type CatalogIcon,
  matchCatalog,
  searchCatalog,
  searchSuggestions,
} from './searchCatalog';
import {
  chatInOptions,
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  type DatePreset,
  fromOptions,
  hasSearchFilters,
  presetOf,
  presetRange,
  type SearchFilterValues,
  todayIn,
} from './searchFilters';

/** The mock's chips always show; Plans, Decisions and Automations (WS-21) when they have results or are chosen. */
export function filterShown(
  value: SearchFilter,
  active: SearchFilter,
  counts: Partial<Record<SearchFilter, number>> | undefined,
  /** GitHub or website feedback is connected: the developer's kinds show (settings-groups.md). */
  developer = true,
): boolean {
  if (value === active) return true;
  if (value === 'patches' || value === 'runs' || value === 'canvases') return developer;
  if (value !== 'plans' && value !== 'decisions' && value !== 'automations') return true;
  return (counts?.[value] ?? 0) > 0;
}

export interface SearchScreenProps {
  burrow: string;
  q: string;
  type: SearchFilter;
  /** `?from=&in=&after=&before=` (AP-448). */
  filters?: SearchFilterValues;
  /** Updates `?q=&type=` and the filters (defaults are left out of the URL). */
  onChange: (next: { q?: string; type?: SearchFilter } & SearchFilterValues) => void;
}

/** Where Back to Search puts you again: the query, the scroll and the result you opened (per tab). */
const RETURN_KEY = 'whombat:search-return';

interface SearchReturn {
  q: string;
  scroll: number;
  key: string;
}

function readReturn(): SearchReturn | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    return raw ? (JSON.parse(raw) as SearchReturn) : null;
  } catch {
    return null;
  }
}

function writeReturn(value: SearchReturn | null) {
  try {
    if (value) sessionStorage.setItem(RETURN_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Storage blocked: Back still brings the query (it is in the address).
  }
}

/**
 * Search (final-shell-web.md; TODO 12): one screen, opened from the sidebar's and the phone bar's Search and ⌘K / Ctrl
 * K. Typing finds the person's chats (the Whombat's full-text search, its type chips and filters, and a cited answer
 * when they ask the assistant), their things, the settings' pages and the places, in four groups said in plain words.
 * An empty query, searching, no results and a search that failed each have their own words. Opening a result keeps the
 * query in the address; Back brings the query, the scroll and the focus on that result again.
 */
export function SearchScreen({ burrow, q, type, filters: asked = {}, onChange }: SearchScreenProps) {
  const { client, queries } = useWhombat();
  const navigate = useNavigateHref();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedFor = useRef<string | null>(null);
  const [text, setText] = useState(q);
  const [askedAnswer, setAskedAnswer] = useState<{ q: string; answer: SearchAnswer } | null>(null);

  const queryClient = useQueryClient();
  const toast = useToast();
  const { managed } = useAppServices();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  // Patches, runs and canvases are a developer's: their chips show only where GitHub or website feedback is connected.
  const developer = useDeveloperTools(burrow);
  // Filters only on a Whombat that has them (`search.filters`); an older one gets the plain query (AP-448).
  const filters: SearchFilterValues = asked;
  const query = { q, type, ...definedOnly(filters) };
  const searchable = q.trim().length > 0 || hasSearchFilters(filters);
  // “Load more”: each further page is its own cached query (so realtime edits reach it too), by the `next` cursors; a
  // short or empty page with a `next` loads on by itself while nothing shows yet (search-pagination.md).
  const pages = useSearchPages(bootstrap && searchable ? { params: { burrow }, query } : null);
  const { data, error: searchError, refetch: refetchSearch } = pages.first;
  const { results, hasMore, loadingMore, moreFailed, searching } = pages;
  const askMutation = useApiMutation(api.search.ask);

  // Who answers: the agent (Whombat one-agent.md OA-07; app one-agent.md AP-4925).
  const { agent: researcher, words } = useTheAgent(burrow);
  // Things, settings and places: found here as the person types (the shell reads Home already).
  const { data: home } = useHomeOverview({ params: { burrow } }, { retry: false });
  const catalog = useMemo(
    () => searchCatalog({ things: home?.things, agent: words.name, here: { managed: managed !== null } }),
    [home?.things, words.name, managed],
  );
  const found = useMemo(() => matchCatalog(catalog, q), [catalog, q]);

  useEffect(() => setText(q), [q]);

  // Back to Search: the scroll and the result opened, once the results are drawn; else the field takes the focus.
  const restored = useRef(false);
  const ready = !q.trim() || found.length > 0 || (!!data && !searching) || !!searchError;
  useEffect(() => {
    if (restored.current || !ready) return;
    restored.current = true;
    const back = readReturn();
    writeReturn(null);
    if (back && back.q === q) {
      if (scrollRef.current) scrollRef.current.scrollTop = back.scroll;
      const row = document.querySelector<HTMLElement>(`[data-search-key="${CSS.escape(back.key)}"]`);
      const target = row?.matches('a, button') ? row : row?.querySelector<HTMLElement>('a, button');
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
    }
    inputRef.current?.focus({ preventScroll: true });
  }, [ready, q]);

  // Debounce URL updates so every keystroke doesn't push a fetch.
  useEffect(() => {
    if (text === q) return;
    const timer = setTimeout(() => onChange({ q: text || undefined }), 250);
    return () => clearTimeout(timer);
  }, [text, q, onChange]);

  const principalById = useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of bootstrap?.principals ?? []) map.set(p.id, p);
    return map;
  }, [bootstrap]);

  // Ask the researcher only when the person asks (web-efficiency.md WE-10): Enter in the field, or “Ask Dusty” in the
  // answer slot; never on a pause in typing, which woke an agent turn for every half-typed query.
  const { mutate: ask, isPending: asking } = askMutation;
  const searchQueryOptions = queries.search.query;
  const askFor = (raw: string) => {
    const trimmed = raw.trim();
    if (!bootstrap || !trimmed || asking || askedFor.current === trimmed) return;
    if (trimmed === q.trim() && data?.answer && data.answer.status !== 'none') return;
    askedFor.current = trimmed;
    const forQuery = { q: trimmed, type, ...definedOnly(filters) };
    ask(
      { params: { burrow }, body: { q: trimmed } },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') return;
          // Fixtures answer synchronously over HTTP with no simulated `search.answer` realtime push
          // (real server pushes one too, but this keeps the UI responsive either way); merge the
          // answer straight into the cached response for the query text it was asked for.
          const { queryKey } = searchQueryOptions({ params: { burrow }, query: forQuery });
          queryClient.setQueryData(queryKey, (prev: typeof data | undefined) =>
            prev ? { ...prev, answer: result.data.answer } : prev,
          );
          // Enter on a query whose results weren't loaded yet: the answer waits here for them.
          setAskedAnswer({ q: trimmed, answer: result.data.answer });
        },
        onError: (err) => {
          // Asking again is allowed after a failure.
          askedFor.current = null;
          // AI search is an agent turn: paused while the subscription has ended (LC-10, LC-14).
          const licence = licenceRefusalText(err);
          if (licence) toast.show(licence);
        },
      },
    );
  };

  if (!bootstrap) return null;

  const pendingAnswer: SearchAnswer | null =
    askMutation.isPending && researcher
      ? {
          id: 'pending',
          burrowId: bootstrap.burrow.id,
          query: q,
          agentId: researcher.id,
          status: 'pending',
          text: '',
          citations: [],
          durationMs: null,
          actions: [],
          createdAt: new Date().toISOString(),
        }
      : null;

  const answer =
    data?.answer && data.answer.status !== 'none'
      ? data.answer
      : askedAnswer?.q === q.trim() && askedAnswer.answer.status !== 'none'
        ? askedAnswer.answer
        : pendingAnswer;
  const answerAgent = answer ? (principalById.get(answer.agentId) ?? researcher) : researcher;

  const handleAction = (action: AnswerAction) => {
    if (!answer || answer.id === 'pending') return;
    if (action.kind === 'post') {
      void client.search.postAnswer({
        params: { burrow, answerId: answer.id },
        body: { conversationId: action.conversationId },
      });
    } else {
      navigate(appPath(action.link));
    }
  };

  // Opening a result: the query goes into the address first, so Back finds it; then where it was is kept.
  const open = (key: string, href: string) => {
    if (text !== q) onChange({ q: text || undefined });
    writeReturn({ q: text, scroll: scrollRef.current?.scrollTop ?? 0, key });
    navigate(href);
  };
  const setQuery = (next: string) => {
    setText(next);
    onChange({ q: next || undefined });
    inputRef.current?.focus();
  };

  const typed = q.trim();
  const refined = hasSearchFilters(filters) || type !== 'all';
  const chatsLoading = searchable && (!data || searching) && !searchError;
  const chatsFailed = searchable && !!searchError && !data;
  const chatCount = data && !searching ? results.length : 0;
  const total = found.length + chatCount;
  // “No results” only when nothing else can come: no next page, no answer, no filter to change.
  const nothing = !!typed && !chatsLoading && !chatsFailed && total === 0 && !hasMore && !answer && !refined;
  // One state for the whole page while nothing is known yet (the first answer, or a failed one); else the groups, the
  // chats searching again in their own group.
  const state: 'empty' | 'loading' | 'failed' | 'none' | 'results' = !searchable
    ? 'empty'
    : found.length === 0 && !data && !searchError
      ? 'loading'
      : found.length === 0 && chatsFailed
        ? 'failed'
        : nothing
          ? 'none'
          : 'results';
  const status =
    state === 'loading'
      ? SEARCH_WORDS.searching
      : state === 'failed'
        ? SEARCH_WORDS.failedStatus
        : state === 'none'
          ? SEARCH_WORDS.noResults
          : state === 'results' && !chatsLoading
            ? SEARCH_WORDS.results(total)
            : state === 'results'
              ? SEARCH_WORDS.searching
              : '';
  const byGroup = (group: CatalogGroup) => found.filter((e) => e.group === group);
  const showChats = searchable && (chatsLoading || chatsFailed || results.length > 0 || hasMore || refined);

  return (
    <div ref={scrollRef} className={styles.scroll} data-screen="search">
      <div className={styles.page}>
        <div>
          <h1 id={`${ids}-title`} className={styles.title} tabIndex={-1}>
            {SEARCH_WORDS.title}
          </h1>
          <p className={styles.intro}>{SEARCH_WORDS.intro}</p>
        </div>
        <search>
          <form
            className={styles.field}
            onSubmit={(e) => {
              e.preventDefault();
              if (text !== q) onChange({ q: text || undefined });
              askFor(text);
            }}
          >
            <label className={styles.fieldLabel}>
              <Icon icon={SearchIcon} size={20} className={styles.fieldIcon} />
              <span className={styles.srOnly}>{SEARCH_WORDS.field}</span>
              <input
                ref={inputRef}
                data-search-input
                className={styles.input}
                autoComplete="off"
                enterKeyHint="search"
                value={text}
                aria-controls={`${ids}-results`}
                // Esc is the shell's: back to where search was opened from (WE-12).
                onChange={(e) => setText(e.target.value)}
                placeholder={SEARCH_WORDS.field}
              />
            </label>
            {text ? (
              <IconButton
                label={SEARCH_WORDS.clear}
                className={styles.clearField}
                onClick={() => setQuery('')}
              >
                <Icon icon={X} size={18} />
              </IconButton>
            ) : null}
          </form>
        </search>
        <p className={styles.meta} role="status" aria-live="polite">
          {status}
        </p>
        <div id={`${ids}-results`} className={styles.groups}>
          {answer && answerAgent && (
            <AnswerCard
              answer={answer}
              agentName={answerAgent.name}
              agentFace={answerAgent.kind === 'agent' ? agentFaceOf(answerAgent) : agentFaceOf(researcher)}
              onAction={handleAction}
              citationHref={(n) => {
                // A receipt opens the exact decision, step or result it cites (WS-25).
                const id = answer.citations.find((c) => c.n === n)?.resultId;
                const result = results.find((r) => r.id === id);
                return result ? appPath(result.link) : null;
              }}
              onNavigate={navigate}
            />
          )}
          {state === 'empty' ? (
            <section className={styles.state} aria-labelledby={`${ids}-state`}>
              <Icon icon={SearchIcon} size={30} className={styles.stateIcon} />
              <h2 id={`${ids}-state`} className={styles.stateTitle}>
                {SEARCH_WORDS.emptyTitle}
              </h2>
              <p className={styles.stateBody}>{SEARCH_WORDS.emptyBody}</p>
              <fieldset className={styles.suggestions}>
                <legend className={styles.srOnly}>{SEARCH_WORDS.suggestions}</legend>
                {searchSuggestions(catalog, words.name).map((word) => (
                  <Button key={word} variant="secondary" size="md" onClick={() => setQuery(word)}>
                    {word}
                  </Button>
                ))}
              </fieldset>
            </section>
          ) : state === 'loading' ? (
            <section
              className={styles.state}
              aria-busy="true"
              aria-labelledby={`${ids}-state`}
              data-state="loading"
            >
              <h2 id={`${ids}-state`} className={styles.stateTitle}>
                {SEARCH_WORDS.loadingTitle(typed)}
              </h2>
              <div className={styles.skeleton} aria-hidden="true" />
              <div className={cx(styles.skeleton, styles.skeletonShort)} aria-hidden="true" />
            </section>
          ) : state === 'failed' ? (
            <section className={styles.state} aria-labelledby={`${ids}-state`}>
              <h2 id={`${ids}-state`} className={styles.stateTitle}>
                {SEARCH_WORDS.failedTitle}
              </h2>
              <p className={styles.stateBody}>{SEARCH_WORDS.failedBody}</p>
              <Button
                variant="secondary"
                size="md"
                className={styles.stateButton}
                onClick={() => void refetchSearch()}
              >
                {SEARCH_WORDS.tryAgain}
              </Button>
            </section>
          ) : state === 'none' ? (
            <section className={styles.state} aria-labelledby={`${ids}-state`}>
              <Icon icon={SearchIcon} size={30} className={styles.stateIcon} />
              <h2 id={`${ids}-state`} className={styles.stateTitle}>
                {SEARCH_WORDS.noResultsTitle(typed)}
              </h2>
              <p className={styles.stateBody}>{SEARCH_WORDS.noResultsBody}</p>
              <Button
                variant="secondary"
                size="md"
                className={styles.stateButton}
                onClick={() => setQuery('')}
              >
                {SEARCH_WORDS.clear}
              </Button>
            </section>
          ) : (
            <>
              {showChats && (
                <section className={styles.group} aria-labelledby={`${ids}-chats`} data-search-group="chats">
                  <h2 id={`${ids}-chats`} className={styles.groupTitle}>
                    {SEARCH_WORDS.groups.chats}
                  </h2>
                  <div className={styles.filters}>
                    {SEARCH_FILTERS.filter((value) => filterShown(value, type, data?.counts, developer)).map(
                      (value) => (
                        <Chip
                          key={value}
                          active={type === value}
                          count={data?.counts?.[value] ?? 0}
                          onClick={() => onChange({ type: value })}
                        >
                          {SEARCH_FILTER_LABELS[value]}
                        </Chip>
                      ),
                    )}
                  </div>
                  <SearchRefine
                    burrow={burrow}
                    filters={filters}
                    principals={bootstrap.principals}
                    timeZone={viewerTimeZone(bootstrap)}
                    onChange={onChange}
                  />
                  {chatsFailed ? (
                    <ErrorNote message={SEARCH_WORDS.chatsFailed} onRetry={() => void refetchSearch()} />
                  ) : chatsLoading ? (
                    <SkeletonRows count={3} lines={2} />
                  ) : results.length > 0 ? (
                    <div className={styles.list}>
                      {results.map((result) => (
                        <div key={result.id} data-search-key={`chat:${result.id}`} className={styles.chatRow}>
                          <SearchResultRow
                            result={result}
                            author={principalById.get(result.authorId)}
                            onOpen={() => open(`chat:${result.id}`, appPath(result.link))}
                          />
                        </div>
                      ))}
                    </div>
                  ) : hasMore ? null : (
                    <EmptyNote>{SEARCH_WORDS.noChats(typed)}</EmptyNote>
                  )}
                  {moreFailed && (
                    <ErrorNote
                      message="Couldn’t load more results. Try again in a moment."
                      onRetry={pages.retryMore}
                    />
                  )}
                  {hasMore && !moreFailed && !chatsLoading && (
                    <Button
                      variant="secondary"
                      size="md"
                      className={styles.loadMore}
                      disabled={loadingMore}
                      onClick={pages.loadMore}
                    >
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  )}
                </section>
              )}
              {(['things', 'settings', 'places'] as const).map((group) => {
                const rows = byGroup(group);
                if (!rows.length) return null;
                return (
                  <section
                    key={group}
                    className={styles.group}
                    aria-labelledby={`${ids}-${group}`}
                    data-search-group={group}
                  >
                    <h2 id={`${ids}-${group}`} className={styles.groupTitle}>
                      {SEARCH_WORDS.groups[group]}
                    </h2>
                    <div className={styles.list}>
                      {rows.map((entry) => (
                        <CatalogRow
                          key={entry.key}
                          entry={entry}
                          onOpen={() => open(entry.key, entry.href)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
              {!answer && researcher && data && !searching && typed && (
                <AskCard
                  agentName={researcher.name}
                  agentFace={agentFaceOf(researcher)}
                  onAsk={() => askFor(q)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SETTING_ICONS: Record<Extract<CatalogIcon, { kind: 'setting' }>['group'], LucideIcon> = {
  you: UserRound,
  agent: Bot,
  connections: Plug,
  appliance: Box,
  advanced: SlidersHorizontal,
};

const PLACE_ICONS: Record<AppPlace, LucideIcon> = {
  search: SearchIcon,
  chat: MessageCircle,
  inbox: Inbox,
  overview: LayoutGrid,
  automations: Zap,
  files: Folder,
  vault: Lock,
  usage: ChartNoAxesColumn,
  settings: Settings,
};

/** A thing, a setting or a place: its logo or icon, its name, one line, a chevron; the whole row opens it. */
function CatalogRow({ entry, onOpen }: { entry: CatalogEntry; onOpen: () => void }) {
  const { icon } = entry;
  return (
    <a
      href={entry.href}
      className={styles.row}
      data-search-key={entry.key}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className={styles.rowMark} aria-hidden="true">
        {icon.kind === 'mark' ? (
          <BrandMark mark={icon.mark} size={20} />
        ) : icon.kind === 'glyph' ? (
          <Icon icon={THING_ICONS[icon.glyph]} size={20} />
        ) : icon.kind === 'place' ? (
          <Icon icon={PLACE_ICONS[icon.place]} size={20} />
        ) : (
          <Icon icon={SETTING_ICONS[icon.group]} size={20} />
        )}
      </span>
      <span className={styles.rowText}>
        <strong className={styles.rowTitle}>{entry.title}</strong>
        <small className={styles.rowLine}>{entry.line}</small>
      </span>
      <Icon icon={ChevronRight} size={16} className={styles.rowChevron} />
    </a>
  );
}

function definedOnly(f: SearchFilterValues): SearchFilterValues {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as SearchFilterValues;
}

interface SearchRefineProps {
  burrow: string;
  filters: SearchFilterValues;
  principals: readonly Principal[];
  timeZone: string;
  onChange: (next: SearchFilterValues) => void;
}

/**
 * The filters under the type chips (AP-448): From (a person or an agent), In (a conversation), a date menu with custom
 * dates, and “Clear filters”. Native selects in the chips' pill frame; a set filter gets the ink border.
 */
function SearchRefine({ burrow, filters, principals, timeZone, onChange }: SearchRefineProps) {
  const ids = useId();
  const today = todayIn(timeZone);
  const preset = presetOf(filters, today);
  const [custom, setCustom] = useState(preset === 'custom');
  const shownPreset: DatePreset = custom ? 'custom' : preset;
  const from = fromOptions(principals);
  // The conversations are the person's chats (AP-1808).
  const { data: chats } = useChats({ params: { burrow }, query: {} }, { retry: false });
  const where = chatInOptions(chats?.chats ?? []);
  const any = hasSearchFilters(filters);

  return (
    <div className={styles.refine} data-search-filters="">
      <label className={cx(styles.select, filters.from && styles.selectSet)}>
        <span className={styles.srOnly}>From</span>
        <select
          value={filters.from ?? ''}
          onChange={(event) => onChange({ from: event.target.value || undefined })}
        >
          <option value="">From anyone</option>
          {from.map((o) => (
            <option key={o.value} value={o.value}>
              From {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </label>
      <label className={cx(styles.select, filters.in && styles.selectSet)}>
        <span className={styles.srOnly}>In</span>
        <select
          value={filters.in ?? ''}
          onChange={(event) => onChange({ in: event.target.value || undefined })}
        >
          <option value="">Anywhere</option>
          {where.map((o) => (
            <option key={o.value} value={o.value}>
              In {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </label>
      <label className={cx(styles.select, shownPreset !== 'any' && styles.selectSet)}>
        <span className={styles.srOnly}>When</span>
        <select
          value={shownPreset}
          onChange={(event) => {
            const next = event.target.value as DatePreset;
            setCustom(next === 'custom');
            onChange(presetRange(next, today, filters));
          }}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {DATE_PRESET_LABELS[p]}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </label>
      {shownPreset === 'custom' && (
        <span className={styles.dates}>
          <label className={styles.dateField} htmlFor={`${ids}-after`}>
            <span>
              Start<span className={styles.srOnly}> date</span>
            </span>
            <input
              id={`${ids}-after`}
              type="date"
              className={styles.date}
              value={filters.after ?? ''}
              max={filters.before ?? today}
              onChange={(event) => onChange({ after: event.target.value || undefined })}
            />
          </label>
          <label className={styles.dateField} htmlFor={`${ids}-before`}>
            <span>
              End<span className={styles.srOnly}> date</span>
            </span>
            <input
              id={`${ids}-before`}
              type="date"
              className={styles.date}
              value={filters.before ?? ''}
              min={filters.after}
              max={today}
              onChange={(event) => onChange({ before: event.target.value || undefined })}
            />
          </label>
        </span>
      )}
      {any && (
        <Button
          variant="link"
          className={styles.clear}
          onClick={() => {
            setCustom(false);
            onChange({ from: undefined, in: undefined, after: undefined, before: undefined });
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
