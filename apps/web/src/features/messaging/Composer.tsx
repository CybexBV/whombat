import {
  composerMentionTargets,
  PROMPT_WORDS,
  promptPreview,
  type UploadItem,
  uploadStatusText,
} from '@whombat/client';
import type { VoiceTypingView } from '@whombat/client/voice/react';
import type { Principal, Prompt, PromptProject } from '@whombat/core';
import { ArrowUp, Paperclip } from 'lucide-react';
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useWebI18n, type WebTranslator } from '../../i18n/provider';
import { PromptPicker } from '../prompts/PromptPicker';
import { PROMPT_WEB_WORDS, type SlashOption, slashOptions } from '../prompts/promptsModel';
import type { PromptProjectsState } from '../prompts/usePrompts';
import { useComposerVoice } from '../voice/useComposerVoice';
import { MicButton, VoiceBar, voiceBarShown } from '../voice/VoiceBar';
import styles from './Composer.module.css';
import { messageFits, TOO_LONG_NOTE } from './messageLimit';
import { activeCommand, insertTrigger, type SkillCommand } from './model';
import { useMentionAutocorrect } from './useMentionAutocorrect';

/** A chip in the composer: an upload in flight, ready to send, or failed (docs/decisions/bp-attachments.md). */
export type ComposerAttachment = UploadItem;

/**
 * The person's prompts `/` offers above the skills (docs/app/decisions/prompts-web.md): the list, T3 Code's projects for
 * the repository picker (asked while it is open, `onPicker`), and using a prompt on one, which resolves true once the
 * message is posted (the draft then clears; the room says why when it isn't).
 */
export interface ComposerPrompts {
  list: readonly Prompt[];
  projects: PromptProjectsState;
  onPicker: (open: boolean) => void;
  use: (prompt: Prompt, project: PromptProject) => Promise<boolean>;
}

export interface ComposerProps {
  /** "Message #billing-v2", "Comment on PR #482", "Message Dusty". */
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Enter or Send with a non-empty draft. */
  onSubmit: (text: string) => void;
  /**
   * Who `@Name` can mean, for its case only (`@neo ` becomes `@Neo `, AP-607). There is no `@` list: a message in Chat
   * always reaches the agent (Whombat one-agent.md OA-07; app one-agent.md AP-4949).
   */
  mentionables: readonly Principal[];
  viewerId?: string;
  /** `+ file`, paste and drop: null when uploads are unavailable (the chip is disabled with a tooltip). */
  onPickFiles?: ((files: File[]) => void) | null;
  attachments?: readonly ComposerAttachment[];
  /** × on a chip: cancel an upload in flight, or remove the file (by `localId`). */
  onRemoveAttachment?: (localId: string) => void;
  onRetryAttachment?: (localId: string) => void;
  /** Inline note under the tools ("Mention @Neo to use /docx."); announced politely. */
  notice?: ReactNode;
  /** Focus the input when this changes (e.g. after a DM suggestion fills it). */
  focusKey?: unknown;
  /**
   * The agent's enabled skills `/` offers (skills-library.md SL-09; the channels' `/topic` and `/invite` went with them,
   * OA-04). Sending one is the parent's
   * (`useSend` with the same list).
   */
  skills?: readonly SkillCommand[];
  /** The person's prompts, above the skills; absent: none (another room, a box without prompts). */
  prompts?: ComposerPrompts | null;
  /** The line beside the tools, where a conversation has one. */
  hint?: string;
  /**
   * ↑ in the empty composer edits the viewer's newest message (a common chat convention; essentials-messages.md
   * AP-441). Returns true when it did, and the key does nothing else then.
   */
  onEditLast?: () => boolean;
  /**
   * Whether the `/ command` chip shows (default true). Hidden while the agent has no skills: `/` has nothing to offer
   * (WX-08).
   */
  commandTool?: boolean;
  /**
   * `chat` (the Chat room, Automations) and `reply` (a thread's reply box, WX-04): the one composer — one row of the
   * field, “File” with its paperclip, the model's mark, the mic and the round send; they differ only in their dock and
   * their words. `composer` (default): another room's card with the `/ command` and `+ file` chips and Send. The `/`
   * list, uploads, paste and ↑ work in all of them.
   */
  variant?: 'composer' | 'reply' | 'chat';
  /** Where the one composer sits: under a room's message column (default) or in a page's own column (Automations). */
  place?: 'room' | 'page';
  /**
   * What answers in Chat (chat-runtime.md AP-2690): the provider's mark as a button, after “File”. Null: none (another
   * room, a runtime without `chat.runtime`).
   */
  runtimeTool?: ReactNode;
  /**
   * The burrow a voice typing recording is sent for (docs/decisions/dictation.md DT-01): with it the composer has a mic
   * where the Whombat offers voice typing. Without it (stories, tests) none.
   */
  burrow?: string;
  /** Which draft this is (a conversation, a thread): a recording for another draft is dropped. Default `placeholder`. */
  voiceKey?: string;
}

/** The English of two notes the composer shows in the page's language, for the tests that look for them. */
export const UPLOADS_UNAVAILABLE = 'File uploads aren’t available yet';
export const WAIT_FOR_UPLOADS = 'Wait for the upload to finish';

/** What screen readers hear about the chips: counts, not every percent. */
function uploadsSummary(items: readonly ComposerAttachment[], { t, tp }: WebTranslator): string {
  if (!items.length) return '';
  const count = (state: ComposerAttachment['state']) => items.filter((a) => a.state === state).length;
  const parts = [
    count('uploading') && t('chat.composer.uploadingCount', { n: count('uploading') }),
    count('ready') && t('chat.composer.readyCount', { n: count('ready') }),
    count('failed') && t('chat.composer.failedCount', { n: count('failed') }),
  ].filter(Boolean);
  return `${tp('chat.composer.files', items.length)}: ${parts.join(', ')}`;
}

type Popover = { kind: 'command'; options: SlashOption[] } | null;

const NO_PROMPTS: readonly Prompt[] = [];

/**
 * Message composer (README "Composer"): 16px-radius card, 16px input, tool chips `/ command`, `+ file`, the hint and
 * Send. Enter sends, Shift+Enter adds a line. `/` at the start opens a command list; ↑/↓ move, Enter/Tab pick, Esc
 * closes. No `@ agent` and no `@` list (one-agent.md AP-4949). With a `burrow`, the mic of voice typing before Send
 * (docs/decisions/dictation.md DT-01): while it records the row is the recording bar, and the words go in the draft.
 */
export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  if (props.burrow) return <VoiceComposer {...props} burrow={props.burrow} inputRef={inputRef} />;
  return <ComposerView {...props} inputRef={inputRef} voice={null} />;
}

/** A composer with voice typing (its hooks need the app's services, which a composer alone in a test hasn't). */
function VoiceComposer(
  props: ComposerProps & { burrow: string; inputRef: RefObject<HTMLTextAreaElement | null> },
) {
  const voice = useComposerVoice({
    burrow: props.burrow,
    ownerKey: props.voiceKey ?? props.placeholder,
    value: props.value,
    onValueChange: props.onValueChange,
    inputRef: props.inputRef,
  });
  return <ComposerView {...props} voice={voice} />;
}

function ComposerView({
  placeholder,
  value,
  onValueChange,
  onSubmit,
  mentionables,
  viewerId,
  onPickFiles = null,
  attachments = [],
  onRemoveAttachment,
  onRetryAttachment,
  notice,
  focusKey,
  skills = [],
  prompts = null,
  hint,
  onEditLast,
  commandTool = true,
  variant = 'composer',
  place = 'room',
  runtimeTool = null,
  inputRef,
  voice,
}: ComposerProps & { inputRef: RefObject<HTMLTextAreaElement | null>; voice: VoiceTypingView | null }) {
  const reply = variant === 'reply';
  const chat = variant === 'chat';
  // Chat, a Chat thread's reply box and Automations share one composer; other rooms keep the chip row.
  const one = reply || chat;
  // While voice typing records or works, its bar is the composer's row and the field waits hidden.
  const listening = voiceBarShown(voice);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const words = useWebI18n();
  const { t } = words;
  const ids = useId();
  const listId = `${ids}-list`;
  // `@neo ` becomes `@Neo ` as it is typed (AP-607).
  const targets = useMemo(() => composerMentionTargets(mentionables, viewerId), [mentionables, viewerId]);
  const autocorrect = useMentionAutocorrect(inputRef, targets, onValueChange, setCaret);
  const hintId = `${ids}-hint`;
  const fileNoteId = `${ids}-file`;

  const promptList = prompts?.list ?? NO_PROMPTS;
  // A repository prompt chosen: the list turns into its repository picker until Escape, a choice or a new draft.
  const [picking, setPicking] = useState<Prompt | null>(null);
  const command = activeCommand(value);
  const popoverKey = command ? `/${command.query}` : null;
  let popover: Popover = null;
  if (popoverKey && popoverKey !== dismissed && !picking) {
    if (command && (skills.length > 0 || promptList.length > 0))
      popover = { kind: 'command', options: slashOptions(promptList, skills, command.query) };
  }
  const optionCount = popover?.options.length ?? 0;
  const activeIndex = optionCount ? Math.min(active, optionCount - 1) : -1;

  // Keep the highlighted option at the top whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every new query
  useEffect(() => setActive(0), [popoverKey]);
  // The highlighted row stays in view as ↑/↓ move through both groups.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);
  // Another draft closes the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every change of the draft
  useEffect(() => setPicking(null), [value]);
  const onPicker = prompts?.onPicker;
  const pickerOpen = !!picking;
  useEffect(() => {
    if (!onPicker) return;
    onPicker(pickerOpen);
    return () => onPicker(false);
  }, [onPicker, pickerOpen]);

  // A long draft gets the box's whole width: once it runs past one line (or has a line break) the one composer's
  // buttons move under the text, and come back beside it when the box is empty again. Not before: a draft that
  // wrapped beside the buttons could fit on one line without them, and the buttons would jump back and forth.
  const [stacked, setStacked] = useState(false);
  // Grow with the draft up to about half the window, then scroll inside (CSS `max-height`); a paste grows it at once.
  // Measured again once the buttons moved under it (the text is wider then). Also applies a caret move queued by an
  // insertion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text or the row's layout changes
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (one) {
      if (!value) setStacked(false);
      else if (!stacked) {
        const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
        if (value.includes('\n') || el.scrollHeight > line * 1.5) setStacked(true);
      }
    }
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value, stacked]);

  useEffect(() => {
    if (focusKey === undefined) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setCaret(el.value.length);
  }, [focusKey, inputRef]);

  const update = (next: { text: string; caret: number }) => {
    pendingCaret.current = next.caret;
    onValueChange(next.text);
    inputRef.current?.focus();
  };

  const choose = (index: number) => {
    if (!popover) return;
    const option = popover.options[index];
    if (!option) return;
    if (option.kind === 'skill') {
      update({ text: option.skill.insert, caret: option.skill.insert.length });
      return;
    }
    // A prompt for a repository asks which; another one's words become the draft, to send as they are or change.
    if (option.prompt.onRepository && prompts) setPicking(option.prompt);
    else update({ text: option.prompt.text, caret: option.prompt.text.length });
  };

  const closePicker = () => {
    setPicking(null);
    inputRef.current?.focus();
  };

  const uploading = attachments.some((a) => a.state === 'uploading');
  // Longer than this Whombat takes (AP-327): Send waits, the note says why.
  const tooLong = !messageFits(value.trim());
  const submit = () => {
    const text = value.trim();
    if (uploading || tooLong || listening) return;
    if (!text && !attachments.some((a) => a.state === 'ready')) return;
    onSubmit(text);
  };

  // Pasted files and screenshots become uploads; pasted text stays text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPickFiles) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    onPickFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Back in the field while the picker is open: Escape goes back to the list, Enter waits for a repository.
    if (picking && (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      if (event.key === 'Escape') setPicking(null);
      return;
    }
    if (popover && optionCount > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + optionCount) % optionCount);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        choose(activeIndex);
        return;
      }
    }
    if (
      event.key === 'ArrowUp' &&
      !value &&
      !attachments.length &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      onEditLast?.()
    ) {
      event.preventDefault();
      return;
    }
    if (popover && event.key === 'Escape') {
      // Close the list only; the shell must not close the pane or modal behind it.
      event.preventDefault();
      setDismissed(popoverKey);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onValueChange(event.target.value);
    setCaret(event.target.selectionStart ?? event.target.value.length);
    autocorrect(event, value);
  };

  const syncCaret = () => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const optionId = (i: number) => `${listId}-${i}`;

  const promptOptions = popover?.options.filter((o) => o.kind === 'prompt') ?? [];
  const skillOptions = popover?.options.filter((o) => o.kind === 'skill') ?? [];
  const optionRow = (o: SlashOption, i: number) => (
    <div
      key={o.kind === 'prompt' ? `p:${o.prompt.id}` : `s:${o.skill.name}`}
      id={optionId(i)}
      role="option"
      tabIndex={-1}
      aria-selected={i === activeIndex}
      className={cx(styles.option, i === activeIndex && styles.optionActive, styles.skillOption)}
      data-slash={o.kind}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setActive(i)}
      onClick={() => choose(i)}
      onKeyDown={() => {}}
    >
      {o.kind === 'prompt' ? (
        <>
          <span className={styles.skillHead}>
            <span className={styles.promptTitle}>{o.prompt.title}</span>
          </span>
          <span className={styles.skillDescription} title={o.prompt.text}>
            {promptPreview(o.prompt.text)}
          </span>
        </>
      ) : (
        <>
          <span className={styles.skillHead}>
            <span className={styles.commandUsage}>/{o.skill.name}</span>
          </span>
          <span className={styles.skillDescription} title={o.skill.description}>
            {o.skill.description}
          </span>
        </>
      )}
    </div>
  );

  const popoverEl = picking ? (
    <div
      className={cx(styles.popover, reply && styles.popoverReply, styles.popoverWide)}
      data-prompt-picker=""
    >
      <PromptPicker
        prompt={picking}
        projects={prompts?.projects ?? { projects: null, t3: null, loading: true }}
        onBack={closePicker}
        onInstead={() => {
          setPicking(null);
          update({ text: picking.text, caret: picking.text.length });
        }}
        onChoose={async (project) => {
          const ok = (await prompts?.use(picking, project)) ?? false;
          if (ok) {
            setPicking(null);
            pendingCaret.current = 0;
            onValueChange('');
            inputRef.current?.focus();
          }
          return ok;
        }}
      />
    </div>
  ) : (
    popover && (
      <div className={cx(styles.popover, reply && styles.popoverReply, styles.popoverWide)}>
        {optionCount === 0 ? (
          <>
            {promptList.length === 0 && (
              <span className={styles.popoverLabel}>{t('chat.composer.skillsLabel')}</span>
            )}
            <p className={styles.empty}>
              {promptList.length === 0 ? t('chat.composer.noSkill') : PROMPT_WEB_WORDS.nothing}
            </p>
          </>
        ) : promptOptions.length === 0 ? (
          <>
            <span className={styles.popoverLabel}>{t('chat.composer.skillsLabel')}</span>
            <div className={styles.options} role="listbox" id={listId} aria-label={t('chat.composer.skills')}>
              {skillOptions.map((o, i) => optionRow(o, i))}
            </div>
          </>
        ) : (
          <div
            className={styles.options}
            role="listbox"
            id={listId}
            aria-label={skillOptions.length ? PROMPT_WEB_WORDS.menuLabel : PROMPT_WORDS.title}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox */}
            <div role="group" aria-labelledby={`${listId}-prompts`} className={styles.options}>
              <span id={`${listId}-prompts`} className={styles.popoverLabel}>
                {PROMPT_WORDS.group}
              </span>
              {promptOptions.map((o, i) => optionRow(o, i))}
            </div>
            {skillOptions.length > 0 && (
              // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
              <div
                role="group"
                aria-labelledby={`${listId}-skills`}
                className={cx(styles.options, styles.groupAfter)}
              >
                <span id={`${listId}-skills`} className={styles.popoverLabel}>
                  {t('chat.composer.skillsLabel')}
                </span>
                {skillOptions.map((o, i) => optionRow(o, promptOptions.length + i))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  );

  const attachmentsEl = attachments.length > 0 && (
    <ul
      className={cx(styles.attachments, reply && styles.replyAttachments)}
      aria-label={t('chat.composer.attachments')}
    >
      {attachments.map((a) => {
        const pct = Math.round(a.progress * 100);
        return (
          <li key={a.localId} className={cx(styles.attachment, a.state === 'failed' && styles.failed)}>
            <span className={styles.attachmentName} title={a.name}>
              {a.name}
            </span>
            <span className={styles.attachmentStatus} role={a.state === 'failed' ? 'alert' : undefined}>
              {uploadStatusText(a)}
            </span>
            {a.state === 'uploading' && (
              <span
                className={styles.progress}
                role="progressbar"
                aria-label={t('chat.composer.uploading', { name: a.name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <span className={styles.progressFill} style={{ width: `${pct}%` }} />
              </span>
            )}
            {a.state === 'failed' && onRetryAttachment && (
              <button
                type="button"
                className={styles.retryAttachment}
                aria-label={t('chat.composer.retryFile', { name: a.name })}
                onClick={() => onRetryAttachment(a.localId)}
              >
                {t('chat.composer.retry')}
              </button>
            )}
            {onRemoveAttachment && (
              <button
                type="button"
                className={styles.removeAttachment}
                aria-label={t(
                  a.state === 'uploading' ? 'chat.composer.cancelFile' : 'chat.composer.removeFile',
                  {
                    name: a.name,
                  },
                )}
                title={a.state === 'uploading' ? t('common.cancel') : t('chat.composer.remove')}
                onClick={() => onRemoveAttachment(a.localId)}
              >
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  // `role="combobox"` on the wrapper, not the `<textarea>`: ARIA-in-HTML disallows overriding a textarea's implicit
  // "textbox" role (axe `aria-allowed-role`), so the combobox owner is this div (aria-owns reaches the listbox even though
  // it isn't a DOM descendant) and the textarea keeps its default textbox role plus the autocomplete wiring. The div is
  // never the focus target: the textarea inside receives and keeps focus, and a tabIndex here would add a redundant stop.
  const fieldEl = (
    // biome-ignore lint/a11y/useFocusableInteractive: the textarea inside takes and keeps focus (see above).
    <div
      role="combobox"
      hidden={(listening && !one) || undefined}
      aria-label={placeholder}
      aria-haspopup="listbox"
      aria-owns={popover && optionCount > 0 ? listId : undefined}
      aria-expanded={!!popover && optionCount > 0}
    >
      <textarea
        ref={inputRef}
        rows={1}
        className={one ? styles.chatInput : styles.input}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-describedby={one ? undefined : hintId}
        aria-autocomplete="list"
        aria-controls={popover && optionCount > 0 ? listId : undefined}
        aria-activedescendant={popover && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        onChange={onChange}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
      />
    </div>
  );

  const fileInput = onPickFiles && (
    <input
      ref={fileRef}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        if (files.length) onPickFiles(files);
        e.target.value = '';
      }}
    />
  );
  const fileNote = !onPickFiles && (
    <span id={fileNoteId} className={styles.srOnly}>
      {t('chat.composer.uploadsUnavailable')}
    </span>
  );
  const fileTool = one ? (
    <>
      <button
        type="button"
        className={cx(styles.fileButton, !onPickFiles && styles.toolDisabled)}
        aria-disabled={!onPickFiles}
        aria-describedby={onPickFiles ? undefined : fileNoteId}
        aria-label={t('chat.composer.attach')}
        title={onPickFiles ? t('chat.composer.attach') : t('chat.composer.uploadsUnavailable')}
        data-composer-attach=""
        onClick={() => {
          if (onPickFiles) fileRef.current?.click();
        }}
      >
        <Icon icon={Paperclip} size={16} />
        <span>{t('chat.composer.file')}</span>
      </button>
      {fileNote}
      {fileInput}
    </>
  ) : (
    <>
      <button
        type="button"
        className={cx(styles.tool, !onPickFiles && styles.toolDisabled)}
        aria-disabled={!onPickFiles}
        aria-describedby={onPickFiles ? undefined : fileNoteId}
        title={onPickFiles ? t('chat.composer.attach') : t('chat.composer.uploadsUnavailable')}
        onClick={() => {
          if (onPickFiles) fileRef.current?.click();
        }}
      >
        {t('chat.composer.fileChip')}
      </button>
      {fileNote}
      {fileInput}
    </>
  );

  const summaryEl = (
    <span className={styles.srOnly} aria-live="polite" data-testid="upload-summary">
      {uploadsSummary(attachments, words)}
    </span>
  );

  const noteText = tooLong ? TOO_LONG_NOTE : (voice?.error ?? notice);

  if (one) {
    // The one composer of Chat, its threads and Automations: the field, “File” with its paperclip, the model's mark and
    // the round send, which fills only once there is something to send. Only the words in the field differ by place.
    const ready = !!value.trim() || attachments.some((a) => a.state === 'ready');
    const held = uploading || tooLong;
    return (
      <div
        className={reply ? styles.replyRoot : place === 'page' ? styles.pageDock : styles.chatDock}
        data-composer={reply ? 'reply' : place === 'page' ? 'page' : 'chat'}
      >
        <div className={styles.chatCard}>
          {popoverEl}
          {attachmentsEl}
          {summaryEl}
          <div className={styles.chatRow} data-stacked={stacked || undefined}>
            <div className={styles.chatField} hidden={listening || undefined}>
              {fieldEl}
            </div>
            {listening ? (
              <VoiceBar voice={voice} size="chat" />
            ) : (
              <>
                {fileTool}
                {runtimeTool}
                {voice ? <MicButton voice={voice} size="chat" /> : null}
                <button
                  type="button"
                  className={cx(styles.send, ready && !held && styles.sendReady)}
                  onClick={submit}
                  aria-label={t('chat.composer.send')}
                  aria-disabled={held || undefined}
                  title={
                    uploading
                      ? t('chat.composer.waitForUploads')
                      : tooLong
                        ? TOO_LONG_NOTE
                        : t('chat.composer.send')
                  }
                  data-ready={(ready && !held) || undefined}
                >
                  <Icon icon={ArrowUp} size={18} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className={reply ? styles.replyNotice : styles.chatNotice} aria-live="polite">
          {noteText}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.dock}>
      <div className={styles.card}>
        {popoverEl}
        {attachmentsEl}
        {summaryEl}
        {fieldEl}
        {listening ? <VoiceBar voice={voice} size="reply" /> : null}
        <div className={styles.tools} hidden={listening || undefined}>
          {commandTool && (
            <button
              type="button"
              className={styles.tool}
              data-composer-command=""
              onClick={() =>
                update(
                  value.trim() === ''
                    ? { text: '/', caret: 1 }
                    : insertTrigger(value, inputRef.current?.selectionStart ?? value.length, '/'),
                )
              }
            >
              {t('chat.composer.commandChip')}
            </button>
          )}
          {fileTool}
          {voice ? <MicButton voice={voice} size="reply" /> : null}
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
          <Button
            variant="primary"
            size="md"
            padX={16}
            padY={7}
            onClick={submit}
            aria-disabled={uploading || tooLong || undefined}
            title={uploading ? t('chat.composer.waitForUploads') : tooLong ? TOO_LONG_NOTE : undefined}
          >
            {t('chat.composer.send')}
          </Button>
        </div>
      </div>
      <div
        className={styles.notice}
        aria-live="polite"
        title={tooLong ? TOO_LONG_NOTE : typeof notice === 'string' ? notice : undefined}
      >
        {noteText}
      </div>
    </div>
  );
}
