/**
 * WEB SEARCH in Settings → Advanced → AI on this Whombat (`#web-search`, Whombat web-search.md). Not in the mocks: it
 * follows its neighbour, the model on your network — the small label, one sentence, a card.
 *
 * - Off: what to do in one line, a link to Brave's API keys page (and its sign-up), the key field and Save. A key Brave
 *   turns away says so under the field.
 * - On: its dot and “On, with your Brave Search key.”, the last check's line; Check again, Use another key (the field
 *   again, with Cancel) and Remove (asks first).
 */
import { ApiError, InvalidRequestError, LOCAL_MODEL_TEXT } from '@whombat/client';
import { useTheAgent } from '@whombat/client/react';
import {
  BRAVE_SEARCH_KEYS_URL,
  BRAVE_SEARCH_SIGNUP_URL,
  type WebSearchCheckState,
  type WebSearchView,
} from '@whombat/core/domain';
import { webSearchCheckText, webSearchCopy } from '@whombat/core/text';
import { type FormEvent, useId, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import styles from './ai.module.css';
import { useClearWebSearch, useSetWebSearch, useTestWebSearch } from './useWebSearch';
import own from './WebSearchSection.module.css';

/** The confirm dialog's kicker (the gateway's “AI GATEWAY” pattern). */
const KICKER = 'WEB SEARCH';

function withAssistant(text: string, assistant: string): string {
  return text.replaceAll('{assistant}', assistant);
}

/** A check's dot: it works, Brave can't be used just now, or the key is refused. */
function checkTone(state: WebSearchCheckState): DotTone {
  return state === 'ok' ? 'ok' : state === 'invalid_key' ? 'bad' : 'warn';
}

/** The server's sentence for a refused write, and the key field's own when it named one. */
function refusalOf(err: unknown): { message: string | null; apiKey: string | null } {
  if (err instanceof InvalidRequestError) return { message: null, apiKey: err.fields.apiKey?.[0] ?? null };
  if (err instanceof ApiError) {
    const apiKey = err.fields.apiKey?.[0] ?? null;
    return { message: apiKey ? null : err.message || LOCAL_MODEL_TEXT.failed, apiKey };
  }
  return { message: LOCAL_MODEL_TEXT.failed, apiKey: null };
}

export function WebSearchSection({ burrow, view }: { burrow: string; view: WebSearchView | null }) {
  const WEB_SEARCH_COPY = useLocaleWords(webSearchCopy);
  const id = useId();
  const { words } = useTheAgent(burrow);
  const [replacing, setReplacing] = useState(false);
  return (
    <section
      className={styles.section}
      aria-labelledby={id}
      id="web-search"
      data-web-search={view ? 'on' : 'off'}
    >
      <SectionLabel as="h2" id={id}>
        {WEB_SEARCH_COPY.title.toUpperCase()}
      </SectionLabel>
      <p className={styles.sectionHelp}>{withAssistant(WEB_SEARCH_COPY.hint, words.Name)}</p>
      <div className={styles.card}>
        {view && !replacing ? (
          <OnRow burrow={burrow} view={view} assistant={words.Name} onReplace={() => setReplacing(true)} />
        ) : (
          <div className={styles.row}>
            <KeyForm
              burrow={burrow}
              onDone={() => setReplacing(false)}
              onCancel={view ? () => setReplacing(false) : null}
            />
          </div>
        )}
      </div>
    </section>
  );
}

/** Web search on: the dot, the line, the last check; Check again, Use another key, Remove. */
function OnRow({
  burrow,
  view,
  assistant,
  onReplace,
}: {
  burrow: string;
  view: WebSearchView;
  assistant: string;
  onReplace: () => void;
}) {
  const WEB_SEARCH_COPY = useLocaleWords(webSearchCopy);
  const toast = useToast();
  const test = useTestWebSearch(burrow);
  const clear = useClearWebSearch(burrow);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = view.check;
  const tone: DotTone = check ? checkTone(check.state) : 'ok';

  const checkAgain = async () => {
    setProblem(null);
    try {
      const result = await test.mutateAsync({ params: { burrow } });
      if (result.status === 'blocked') setProblem(result.message);
    } catch (err) {
      setProblem(refusalOf(err).message ?? LOCAL_MODEL_TEXT.testFailed);
    }
  };

  const remove = async () => {
    setProblem(null);
    try {
      const result = await clear.mutateAsync({ params: { burrow } });
      if (result.status === 'ok') {
        setAsking(false);
        toast.show(WEB_SEARCH_COPY.removed);
        return;
      }
      setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.failed);
    } catch (err) {
      setProblem(refusalOf(err).message ?? LOCAL_MODEL_TEXT.failed);
    }
  };

  return (
    <div className={styles.row} data-web-search-row="" data-check={check?.state ?? 'none'}>
      <div className={styles.head}>
        <StatusDot tone={tone} size={8} label={null} />
        <span className={styles.main}>
          <span className={styles.name}>{WEB_SEARCH_COPY.on}</span>
        </span>
        <span className={styles.headActions}>
          <Button variant="secondary" size="sm" onClick={() => void checkAgain()} disabled={test.isPending}>
            {WEB_SEARCH_COPY.checkAgain}
          </Button>
          <Button variant="secondary" size="sm" onClick={onReplace}>
            {WEB_SEARCH_COPY.replace}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
            {WEB_SEARCH_COPY.remove}
          </Button>
        </span>
      </div>
      {check ? (
        <span className={styles.hint} role="status" data-tone={checkTone(check.state)} data-check-line="">
          {webSearchCheckText(check.state, currentLocale())}
        </span>
      ) : null}
      {problem && !asking ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setAsking(false);
              setProblem(null);
            }
          }}
          kicker={KICKER}
          title={WEB_SEARCH_COPY.removeTitle}
          confirmLabel={WEB_SEARCH_COPY.remove}
          busy={clear.isPending}
          error={problem}
          onConfirm={() => void remove()}
        >
          {withAssistant(WEB_SEARCH_COPY.removeBody, assistant)}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The steps line, the links to Brave, the key field and Save (with Cancel while it replaces a saved key). */
function KeyForm({
  burrow,
  onDone,
  onCancel,
}: {
  burrow: string;
  onDone: () => void;
  onCancel: (() => void) | null;
}) {
  const WEB_SEARCH_COPY = useLocaleWords(webSearchCopy);
  const fieldId = useId();
  const toast = useToast();
  const set = useSetWebSearch(burrow);
  const [apiKey, setApiKey] = useState('');
  const [opened, setOpened] = useState(false);
  const [fieldProblem, setFieldProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const empty = apiKey.trim() === '';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (empty || set.isPending) return;
    setProblem(null);
    setFieldProblem(null);
    try {
      const result = await set.mutateAsync({ params: { burrow }, body: { apiKey: apiKey.trim() } });
      if (result.status === 'ok') {
        toast.show(WEB_SEARCH_COPY.saved);
        onDone();
        return;
      }
      setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.failed);
    } catch (err) {
      const refusal = refusalOf(err);
      setFieldProblem(refusal.apiKey);
      setProblem(refusal.message);
    }
  };

  return (
    <form className={styles.flow} onSubmit={(e) => void save(e)} noValidate data-web-search-form="">
      <p className={own.steps}>{WEB_SEARCH_COPY.steps}</p>
      <div className={own.links}>
        <ButtonLink
          variant={opened || !empty ? 'secondary' : 'primary'}
          size="sm"
          href={BRAVE_SEARCH_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpened(true)}
          iconEnd={<Icon name="external" size={15} />}
        >
          {WEB_SEARCH_COPY.getKey}
        </ButtonLink>
        <ButtonLink variant="link" href={BRAVE_SEARCH_SIGNUP_URL} target="_blank" rel="noopener noreferrer">
          {WEB_SEARCH_COPY.signUp}
        </ButtonLink>
      </div>
      <div className={own.field}>
        <label className={own.label} htmlFor={fieldId}>
          {WEB_SEARCH_COPY.apiKey}
        </label>
        <div className={own.entry}>
          <Input
            id={fieldId}
            className={own.input}
            type="password"
            value={apiKey}
            invalid={!!fieldProblem}
            aria-describedby={fieldProblem ? `${fieldId}-problem` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setApiKey(e.target.value);
              setFieldProblem(null);
            }}
          />
          <Button variant="primary" size="sm" type="submit" disabled={empty || set.isPending}>
            {WEB_SEARCH_COPY.save}
          </Button>
          {onCancel ? (
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={set.isPending}>
              {LOCAL_MODEL_TEXT.cancel}
            </Button>
          ) : null}
        </div>
        {fieldProblem ? (
          <span id={`${fieldId}-problem`} className={own.fieldProblem} role="alert">
            {fieldProblem}
          </span>
        ) : null}
      </div>
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
    </form>
  );
}
