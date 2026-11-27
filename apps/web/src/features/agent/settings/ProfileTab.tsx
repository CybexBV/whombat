import { WhombatAvatar } from '@whombat/avatars/react';
import {
  type AgentWords,
  ApiError,
  agentFaceBackground,
  agentFaceLabel,
  agentFaceOf,
  agentFaceStyle,
  agentWords,
  InvalidRequestError,
} from '@whombat/client';
import { useSetAgentModel } from '@whombat/client/react';
import {
  AGENT_FACES,
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_MAX,
  AGENT_NAME_PATTERN,
  AGENT_NAME_RESERVED_TEXT,
  type AgentFace,
  agentCharacter,
  isReservedAgentName,
} from '@whombat/core/domain';
import { Check } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Input } from '../../../components/Input';
import { useToast } from '../../../components/Toast';
import { Toggle } from '../../../components/Toggle';
import { useWebI18n } from '../../../i18n/provider';
import { useAssistantPreferences, useSaveAssistantPreferences } from '../../settings/assistantPreferences';
import styles from '../../settings/SettingsScreen.module.css';
import { LiveAgentFace } from '../LiveAgentFace';
import type { SettingsTabProps } from './AgentTab';
import { outcomeNotice } from './model';
import own from './ProfileTab.module.css';

/** A face choice settles this long after the last pick before it is saved: arrow keys walk the faces (AP-1511). */
const FACE_SAVE_MS = 600;

/**
 * Why a name can't be saved, before asking the server (it checks again): the form and the reserved “Whombat”. Null
 * when it may be sent. There is one agent, so no name is taken by another (Whombat one-agent.md OA-08).
 */
export function agentNameProblem(name: string): string | null {
  if (isReservedAgentName(name)) return AGENT_NAME_RESERVED_TEXT;
  if (!AGENT_NAME_PATTERN.test(name)) return AGENT_NAME_FORM_TEXT;
  return null;
}

/**
 * Settings → Agent → Name and character (Whombat one-agent.md OA-08, OA-09; app one-agent.md AP-4924; was Settings →
 * Profile → Your assistant, assistant-name-web.md AP-1508…AP-1512): its face, its name with Save, the five characters
 * (a pick saves; the face is how it looks and talks, agent-voices.md AP-5500, and never renames it, AP-5503) with a
 * line on how the picked one talks (AP-5501), and your own Suggestions from it (what it remembers is Settings →
 * Profile's and Notes', AP-5220). You change the name and the character.
 */
export function ProfileTab({ burrow, profile }: SettingsTabProps) {
  const { tag: uiLocale } = useWebI18n();
  const ids = useId();
  const toast = useToast();
  const { agent } = profile;
  const words = agentWords(agent.name, uiLocale);
  const update = useSetAgentModel(burrow);
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The face just picked, shown at once and saved after `FACE_SAVE_MS`. */
  const [picked, setPicked] = useState<AgentFace | null>(null);
  const faceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start from (and follow) the saved name until the person edits it.
  const savedName = agent.name;
  useEffect(() => setName(savedName), [savedName]);
  useEffect(() => () => clearTimeout(faceTimer.current ?? undefined), []);

  const savedFace = agentFaceOf(agent);
  const face = picked ?? savedFace;
  const trimmed = name.trim();
  const dirty = trimmed !== savedName;

  /** A server refusal on a field, else its message, else null (a transport failure is the toast's). */
  function refusal(err: unknown, field: 'name' | 'face'): string | null {
    if (err instanceof ApiError || err instanceof InvalidRequestError)
      return err.fields[field]?.[0] ?? err.message;
    return null;
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    const problem = agentNameProblem(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await update.mutateAsync({ params: { burrow }, body: { name: trimmed } });
      if (result.status !== 'ok') {
        const notice = outcomeNotice(result);
        if (notice) setError(notice);
        return;
      }
      const saved = result.data.agent.name;
      if (saved !== trimmed) {
        setName(saved);
        setError('Couldn’t save that. Try again in a moment.');
      } else {
        toast.show(words.renamed(saved));
      }
    } catch (err) {
      const message = refusal(err, 'name');
      if (message) setError(message);
      else toast.show('Couldn’t save that. Try again in a moment.');
    } finally {
      setSaving(false);
    }
  }

  function pickFace(next: AgentFace) {
    setPicked(next);
    clearTimeout(faceTimer.current ?? undefined);
    faceTimer.current = setTimeout(() => void saveFace(next), FACE_SAVE_MS);
  }

  async function saveFace(next: AgentFace) {
    if (next === savedFace) {
      setPicked(null);
      return;
    }
    try {
      const result = await update.mutateAsync({ params: { burrow }, body: { face: next } });
      if (result.status !== 'ok') {
        const notice = outcomeNotice(result);
        if (notice) toast.show(notice);
        return;
      }
      if (agentFaceOf(result.data.agent) !== next)
        toast.show('Couldn’t save that face. Try again in a moment.');
      else toast.show(words.newFace);
    } catch (err) {
      toast.show(refusal(err, 'face') ?? 'Couldn’t save that face. Try again in a moment.');
    } finally {
      setPicked(null);
    }
  }

  return (
    <div className={styles.card} data-agent-profile="">
      <form className={`${styles.row} ${own.nameRow}`} onSubmit={saveName} noValidate>
        <span className={own.bust} style={{ background: agentFaceBackground(face) }}>
          {/* A tap pokes it; a face just picked plays its own move. */}
          <LiveAgentFace
            face={face}
            size={96}
            eager
            label={agentFaceLabel(face)}
            state="idle"
            pokeable
            gestureKey={face}
          />
        </span>
        <div className={own.nameField}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-name`}>
            NAME
          </label>
          <div className={own.nameLine}>
            <Input
              id={`${ids}-name`}
              size="lg"
              className={own.nameInput}
              maxLength={AGENT_NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              invalid={error !== null}
              aria-describedby={`${ids}-hint${error ? ` ${ids}-error` : ''}`}
            />
            <Button type="submit" variant="secondary" size="lg" disabled={!dirty || !trimmed || saving}>
              Save
            </Button>
          </div>
          {error ? (
            <span id={`${ids}-error`} className={styles.fieldError} role="alert">
              {error}
            </span>
          ) : null}
          <span id={`${ids}-hint`} className={own.hint}>
            {words.nameHint}
          </span>
        </div>
      </form>
      <div className={`${styles.row} ${own.faceRow}`}>
        <span className={styles.rowMain}>
          <span className={styles.rowTitle} id={`${ids}-face`}>
            Character
          </span>
          <span className={styles.rowMeta} id={`${ids}-face-hint`}>
            How {words.name} looks and talks.
          </span>
        </span>
        <div
          className={own.faces}
          role="radiogroup"
          aria-labelledby={`${ids}-face`}
          aria-describedby={`${ids}-face-hint ${ids}-face-style`}
        >
          {AGENT_FACES.map((key) => (
            <label
              key={key}
              className={own.face}
              data-on={key === face || undefined}
              style={key === face ? { background: agentFaceBackground(key) } : undefined}
              title={agentFaceLabel(key)}
            >
              <input
                type="radio"
                className={own.faceInput}
                name={`${ids}-faces`}
                value={key}
                checked={key === face}
                onChange={() => pickFace(key)}
                aria-label={agentFaceLabel(key)}
              />
              <WhombatAvatar face={key} size={64} crop="bust" eager decorative />
              {key === face ? (
                <span className={own.check} aria-hidden="true">
                  <Icon icon={Check} size={12} />
                </span>
              ) : null}
            </label>
          ))}
        </div>
        {/* How the picked character talks (AP-5501), live while picking. */}
        <p id={`${ids}-face-style`} className={own.style} aria-live="polite">
          <strong className={own.styleName}>{agentCharacter(face).name}</strong>
          {' · '}
          {agentFaceStyle(face)}
        </p>
      </div>
      <SuggestionsRow burrow={burrow} words={words} />
    </div>
  );
}

/**
 * Your own Suggestions from the agent (docs/decisions/assistant-guides.md AG-11, AG-12): now and then it offers to set
 * something up for you; “Don’t ask again” on one of those is undone here.
 */
function SuggestionsRow({ burrow, words }: { burrow: string; words: AgentWords }) {
  const ids = useId();
  const toast = useToast();
  const prefs = useAssistantPreferences(burrow);
  const save = useSaveAssistantPreferences(burrow);
  const failed = () => toast.show('Couldn’t save that. Try again in a moment.');
  return (
    <div className={styles.row}>
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-suggestions`}>
          Suggestions from {words.name}
        </label>
        <span className={styles.rowMeta}>
          Now and then {words.name} offers to set something up for you.
          {prefs.dontAsk.length > 0 ? (
            <>
              {' '}
              <Button
                variant="link"
                size="xs"
                className={styles.inlineLink}
                onClick={() =>
                  save((current) => ({ ...current, dontAsk: [] })).then(
                    () => toast.show(`Reset. ${words.Name} may suggest those again.`),
                    failed,
                  )
                }
              >
                Reset ‘Don’t ask again’
              </Button>
            </>
          ) : null}
        </span>
      </span>
      <Toggle
        id={`${ids}-suggestions`}
        checked={prefs.suggestions}
        onCheckedChange={(suggestions) => save((current) => ({ ...current, suggestions })).catch(failed)}
      />
    </div>
  );
}
