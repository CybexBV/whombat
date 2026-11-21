import { skillLibraryEndpoints as E, type SkillLibrarySkill } from '@whombat/client/skill-library';
import { useSkillLibraryWrite } from '@whombat/client/skill-library/react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { RichText } from '../messaging/RichText';
import styles from './Skills.module.css';
import { SKILLS_WORDS as W } from './skillsWords';

/**
 * **Edit** (Whombat all-skills.md SK-10, SK-17, hermes-skills.md HSK-07; contracts 2.0 CT-1410; app AP-5540, was
 * AP-5233): you change a skill — the description and the SKILL.md's body in Markdown, with a Preview of
 * how it reads, in the skill's dialog; Save or Cancel in its footer. One of Hermes's built-ins not changed yet says,
 * before saving, that it will show as Changed and Restore Hermes’s brings the original back. Hermes's scan checks the
 * edit first (dangerous is refused, with the server's words). The save names the version the edit started from: a
 * skill changed meanwhile is refused with the server's words.
 */
export function SkillEditor({
  burrow,
  detail,
  body,
  marksChanged,
  onDone,
}: {
  burrow: string;
  detail: SkillLibrarySkill;
  /** The body without its front matter. */
  body: string;
  /** Saving changes one of Hermes's built-ins (it shows as Changed until restored). */
  marksChanged: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const ids = useId();
  const edit = useSkillLibraryWrite(E.edit, burrow);
  const [description, setDescription] = useState(detail.item.description);
  const [text, setText] = useState(body);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return setProblem(W.emptyBody);
    setProblem(null);
    const { name } = detail.item;
    try {
      const r = await edit.mutateAsync({
        params: { burrow },
        body: {
          name,
          ...(description.trim() !== detail.item.description ? { description: description.trim() } : {}),
          body: text,
          ifVersion: detail.item.version,
        },
      });
      if (r.status !== 'ok') return setProblem(W.notChanged);
      toast.show(W.saved);
      onDone();
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : W.notChanged);
    }
  }

  return (
    <form className={styles.editor} onSubmit={save}>
      <div className={styles.skillScroll}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-description`}>
            {W.description}
          </label>
          <Input
            id={`${ids}-description`}
            className={styles.textInput}
            value={description}
            maxLength={1024}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel} id={`${ids}-body-label`}>
            {W.instructions}
          </span>
          <SegmentedControl
            size="sm"
            label={W.editMode}
            options={[
              { value: 'write', label: W.write },
              { value: 'preview', label: W.preview },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === 'write' ? (
            <textarea
              className={styles.textarea}
              aria-labelledby={`${ids}-body-label`}
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <div className={styles.body}>
              <RichText text={text} />
            </div>
          )}
        </div>
        {marksChanged && <p className={styles.editNote}>{W.marksChanged}</p>}
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className={styles.skillFoot}>
        <Button type="submit" variant="primary" size="sm" disabled={edit.isPending}>
          {W.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {W.cancel}
        </Button>
      </div>
    </form>
  );
}
