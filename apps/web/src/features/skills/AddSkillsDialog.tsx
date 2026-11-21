import { ApiError } from '@whombat/client';
import {
  fileBytes,
  type HubPreviewModel,
  hubPreviewModel,
  hubRefusalWords,
  hubResultMeta,
  hubUnreachableWords,
  SKILL_HUB_FILTERS,
  SKILL_HUB_TEXT,
  type SkillHubFilter,
  type SkillHubResult,
  skillErrorCode,
} from '@whombat/client/skill-library';
import {
  useSkillHubInstall,
  useSkillHubPreview,
  useSkillHubSearch,
} from '@whombat/client/skill-library/react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { Button, IconButton } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SkeletonRows } from '../../components/ListState';
import { Modal, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { RichText } from '../messaging/RichText';
import styles from './Skills.module.css';

const A = SKILL_HUB_TEXT;

/** Search Hermes's hub a moment after typing stops. */
const FIND_DELAY_MS = 300;

const TONE = { ok: styles.ok, warn: styles.warn, bad: styles.bad, mut: styles.mut } as const;

/** What a refused read or write says, in words: the hub away, a block, a taken name, else the server's own. */
function problemOf(error: unknown, skill: string, fallback: string): string {
  return (
    hubRefusalWords(error, skill) ?? (error instanceof ApiError && error.message ? error.message : fallback)
  );
}

/**
 * **Add skills** = Hermes's hub (Whombat hermes-skills.md HSK-06…HSK-09; contracts 2.0 CT-1413…CT-1415; app
 * AP-5542…AP-5549, was AP-5234): you browse (nothing typed) or search Hermes's own optional skills, its trusted GitHub
 * repositories and skills.sh, all three or one (the chips); each result with its name, what it does, its source and
 * trust in words, installs when skills.sh counts them, and “Installed” once it is here; a note for a source that didn't
 * answer. A result opens its preview in the same dialog: what Hermes's scan found and why its policy allows or blocks it
 * (in plain words), what it needs and the platforms it names, its SKILL.md rendered and its files. **Add** only when the
 * policy allows it and its name is free; a blocked skill has no Install and there is no force (HSK-07). No archive
 * upload or link (HSK-08): your own skill is one the agent learns.
 */
export function AddSkillsDialog({
  burrow,
  assistantName,
  open,
  onClose,
}: {
  burrow: string;
  assistantName: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      padded={false}
      className={styles.skillDialog}
    >
      {open && <AddSkillsBody burrow={burrow} assistantName={assistantName} onClose={onClose} />}
    </Modal>
  );
}

function AddSkillsBody({
  burrow,
  assistantName,
  onClose,
}: {
  burrow: string;
  assistantName: string;
  onClose: () => void;
}) {
  const [find, setFind] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SkillHubFilter>('all');
  const [opened, setOpened] = useState<SkillHubResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(find.trim()), FIND_DELAY_MS);
    return () => clearTimeout(t);
  }, [find]);

  if (opened)
    return <HubPreview burrow={burrow} result={opened} onBack={() => setOpened(null)} onClose={onClose} />;
  return (
    <HubBrowse
      burrow={burrow}
      assistantName={assistantName}
      find={find}
      onFind={setFind}
      query={query}
      source={source}
      onSource={setSource}
      onOpen={setOpened}
      onClose={onClose}
    />
  );
}

/** Browse or search the hub: the field, the source chips, the results, a note for a source that didn't answer. */
function HubBrowse({
  burrow,
  assistantName,
  find,
  onFind,
  query,
  source,
  onSource,
  onOpen,
  onClose,
}: {
  burrow: string;
  assistantName: string;
  find: string;
  onFind: (text: string) => void;
  query: string;
  source: SkillHubFilter;
  onSource: (source: SkillHubFilter) => void;
  onOpen: (result: SkillHubResult) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const search = useSkillHubSearch(
    {
      params: { burrow },
      query: { ...(query ? { q: query } : {}), ...(source !== 'all' ? { source } : {}) },
    },
    { retry: false, placeholderData: (previous) => previous },
  );
  const results = search.data?.results ?? [];
  const unreachable = search.data ? hubUnreachableWords(search.data.unreachable) : null;
  return (
    <>
      <div className={styles.skillHead}>
        <div className={styles.panelHeading}>
          <ModalTitle className={styles.dialogTitle}>{A.title}</ModalTitle>
          <p className={styles.dialogSub}>{A.help(assistantName)}</p>
        </div>
        <IconButton label={A.close} onClick={onClose}>
          <Icon icon={X} size={16} />
        </IconButton>
      </div>
      <div className={styles.hubBar}>
        <label htmlFor={`${ids}-find`} className={styles.srOnly}>
          {A.search}
        </label>
        <Input
          id={`${ids}-find`}
          type="search"
          className={styles.findInput}
          placeholder={A.searchPlaceholder}
          value={find}
          onChange={(e) => onFind(e.target.value)}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset */}
        <div className={styles.chips} role="group" aria-label={A.sources}>
          {SKILL_HUB_FILTERS.map((f) => (
            <Chip
              key={f.value}
              className={styles.chip}
              active={source === f.value}
              onClick={() => onSource(f.value)}
            >
              {f.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className={styles.skillScroll}>
        {search.error && !search.data ? (
          skillErrorCode(search.error) === 'skill_hub_unavailable' ? (
            <p className={styles.addHint} role="status">
              {A.unavailable}
            </p>
          ) : (
            <LoadErrorNote
              error={search.error}
              message={problemOf(search.error, '', A.unavailable)}
              onRetry={() => void search.refetch()}
            />
          )
        ) : !search.data ? (
          <div aria-busy="true">
            <SkeletonRows count={5} lines={2} />
          </div>
        ) : results.length === 0 ? (
          <p className={styles.addHint}>{A.nothingFound}</p>
        ) : (
          <section aria-labelledby={`${ids}-results`}>
            <SectionLabel as="h3" id={`${ids}-results`} className={styles.sublabel}>
              {query ? A.results : A.browsing}
            </SectionLabel>
            <ul className={styles.rows} aria-label={A.results} aria-busy={search.isFetching || undefined}>
              {results.map((r) => (
                <li key={r.identifier} className={styles.hubRow} data-hub={r.identifier}>
                  <button
                    type="button"
                    className={styles.open}
                    aria-haspopup="dialog"
                    onClick={() => onOpen(r)}
                  >
                    <span className={styles.nameLine}>
                      <span className={styles.name}>{r.name}</span>
                    </span>
                    <span className={styles.description} title={r.description}>
                      {r.description}
                    </span>
                    <span className={styles.resultMeta}>{hubResultMeta(r)}</span>
                  </button>
                  {r.installed ? (
                    <span className={cx(styles.status, styles.ok)}>{A.installed}</span>
                  ) : (
                    <Icon icon={ChevronRight} size={16} className={styles.rowChevron} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {unreachable && <p className={styles.addHint}>{unreachable}</p>}
      </div>
      <div className={styles.skillFoot}>
        <span className={styles.footSpacer} />
        <Button variant="secondary" size="sm" onClick={onClose}>
          {A.close}
        </Button>
      </div>
    </>
  );
}

/**
 * One hub skill before Install (HSK-07, CT-1414): Hermes's verdict and why its policy allows or blocks it, the findings,
 * what it needs, the platforms it names, its SKILL.md and files. Install only when allowed and its name is free.
 */
function HubPreview({
  burrow,
  result,
  onBack,
  onClose,
}: {
  burrow: string;
  result: SkillHubResult;
  onBack: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const read = useSkillHubPreview(
    { params: { burrow }, query: { identifier: result.identifier } },
    { retry: false },
  );
  const install = useSkillHubInstall(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const model = read.data ? hubPreviewModel(read.data) : null;

  async function add() {
    setProblem(null);
    try {
      const r = await install.mutateAsync({ identifier: result.identifier });
      if (r.status !== 'ok') return setProblem(A.notAdded);
      toast.show(A.added(r.data.item.name));
      onBack();
    } catch (error) {
      setProblem(problemOf(error, result.name, A.notAdded));
    }
  }

  return (
    <>
      <div className={styles.skillHead}>
        <IconButton label={A.back} onClick={onBack}>
          <Icon icon={ChevronLeft} size={16} />
        </IconButton>
        <div className={styles.panelHeading}>
          <ModalTitle className={styles.panelTitle}>{result.name}</ModalTitle>
          <div className={styles.tag}>{hubResultMeta(result)}</div>
        </div>
        <IconButton label={A.close} onClick={onClose}>
          <Icon icon={X} size={16} />
        </IconButton>
      </div>
      <div className={styles.skillScroll}>
        {model ? (
          <PreviewBody model={model} files={read.data?.files ?? []} />
        ) : read.error ? (
          skillErrorCode(read.error) === 'skill_hub_unavailable' ? (
            <p className={styles.addHint} role="status">
              {A.unavailable}
            </p>
          ) : (
            <LoadErrorNote
              error={read.error}
              message={problemOf(read.error, result.name, A.notRead)}
              onRetry={() => void read.refetch()}
            />
          )
        ) : (
          <div aria-busy="true">
            <SkeletonRows count={5} lines={1} />
          </div>
        )}
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className={styles.skillFoot}>
        {model?.notInstallable && <span className={styles.footNote}>{model.notInstallable}</span>}
        <span className={styles.footSpacer} />
        <Button variant="secondary" size="sm" onClick={onBack}>
          {A.back}
        </Button>
        {model?.canInstall && (
          <Button variant="primary" size="sm" disabled={install.isPending} onClick={() => void add()}>
            {install.isPending ? A.installing : A.install}
          </Button>
        )}
      </div>
    </>
  );
}

function PreviewBody({
  model,
  files,
}: {
  model: HubPreviewModel;
  files: readonly { path: string; bytes: number }[];
}) {
  return (
    <>
      <p className={styles.panelDescription}>{model.description}</p>
      <section
        className={cx(styles.verdict, model.blocked && styles.verdictBlocked)}
        aria-label={A.findings}
        data-verdict={model.verdictTone}
      >
        <SectionLabel as="h3" className={styles.sublabel}>
          {A.findings}
        </SectionLabel>
        <p className={styles.verdictLine}>
          <span className={cx(styles.verdictDot, TONE[model.verdictTone])} aria-hidden="true" />
          <span className={cx(styles.verdictWords, TONE[model.verdictTone])}>{model.verdict}</span>
        </p>
        <p className={cx(styles.verdictReason, model.blocked && styles.bad)}>{model.reason}</p>
        {model.findings.length > 0 && (
          <ul className={styles.findings}>
            {model.findings.map((f) => (
              <li key={`${f.where}:${f.kind}:${f.description}`} className={styles.finding}>
                <span className={styles.findingHead}>
                  <span className={TONE[f.tone]}>{f.kind}</span>
                  <span className={styles.fileSize}>{f.where}</span>
                </span>
                <span className={styles.findingText}>{f.description}</span>
                {f.match && <code className={styles.findingMatch}>{f.match}</code>}
              </li>
            ))}
            {model.moreFindings && <li className={styles.findingText}>{model.moreFindings}</li>}
          </ul>
        )}
      </section>
      {(model.needs.length > 0 || model.platforms) && (
        <ul className={styles.lines} aria-label={A.needs}>
          {model.needs.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {model.platforms && <li>{model.platforms}</li>}
        </ul>
      )}
      <div className={styles.body}>
        <RichText text={model.body} />
      </div>
      {files.length > 0 && (
        <div>
          <SectionLabel as="h4" className={styles.sublabel}>
            {A.files}
          </SectionLabel>
          <ul className={styles.files}>
            {files.map((f) => (
              <li key={f.path} className={styles.fileChange}>
                <span>{f.path}</span>
                <span className={styles.fileSize}>{fileBytes(f.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
