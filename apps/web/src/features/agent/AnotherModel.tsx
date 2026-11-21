import { LOCAL_MODEL_TEXT } from '@whombat/client';
import { MODEL_ID_MAX } from '@whombat/core/domain';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import styles from './AnotherModel.module.css';

/**
 * “Another model” (hermes-engine-app.md AP-5001, AP-5043): a model on the network the list doesn't name, typed, then Use
 * (or Enter) picks it; the field empties and the model shows among the choices. Settings → Agent's MODEL on Local, and
 * the Chat picker's (`compact`: its 13px type and 34px field).
 */
export function AnotherModel({
  onUse,
  compact = false,
  className,
}: {
  onUse: (model: string) => void;
  compact?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState('');
  const ids = { field: useId(), hint: useId() };
  const model = value.trim();
  const use = () => {
    if (!model) return;
    onUse(model);
    setValue('');
  };
  return (
    <div className={cx(styles.another, compact && styles.compact, className)} data-another-model="">
      <label htmlFor={ids.field} className={styles.label}>
        {LOCAL_MODEL_TEXT.another}
      </label>
      <div className={styles.field}>
        <Input
          id={ids.field}
          className={styles.input}
          value={value}
          maxLength={MODEL_ID_MAX}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={ids.hint}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            use();
          }}
        />
        <Button variant="secondary" size={compact ? 'sm' : 'md'} onClick={use} disabled={!model}>
          {LOCAL_MODEL_TEXT.use}
        </Button>
      </div>
      <span id={ids.hint} className={styles.hint}>
        {LOCAL_MODEL_TEXT.anotherHint}
      </span>
    </div>
  );
}
