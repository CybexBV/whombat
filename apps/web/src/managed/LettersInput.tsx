/**
 * The four letters from a Whombat's screen (CC-01, CC-13): any case, spaces and dashes are fine. Claiming a box, and
 * pairing its screen as a desk display (desk-display-web.md AP-3004).
 */
import { formatClaimLettersInput } from '@whombat/client/managed';
import type { InputHTMLAttributes } from 'react';
import { cx } from '../components/cx';
import { Input } from '../components/Input';
import styles from './managed.module.css';

export function LettersInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  ...rest
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
} & Pick<InputHTMLAttributes<HTMLInputElement>, 'aria-describedby' | 'autoFocus'>) {
  return (
    <Input
      id={id}
      size="display"
      className={cx(styles.mono, styles.codeInput)}
      placeholder={placeholder}
      required
      autoComplete="off"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      invalid={invalid}
      value={value}
      onChange={(e) => onChange(formatClaimLettersInput(e.target.value))}
      {...rest}
    />
  );
}
