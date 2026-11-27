/**
 * The name for a box's own address, as typed (Whombat own-address.md; the app's own-address.md): `[ name ].whombat.app`,
 * the live check's line and the privacy words. The account site's confirm step and Settings → ADDRESS's Change use
 * it; the check itself is the caller's (`useOwnNameCheck`).
 */
import { type OwnNameCheck, ownNameLine } from '@whombat/client/managed';
import { Input, type InputSize } from '../components/Input';
import { OWN_NAME_TEXT } from '../i18n/clientWords';
import { currentLocale } from '../i18n/provider';
import styles from './OwnNameField.module.css';

export function OwnNameField({
  id,
  value,
  onChange,
  check,
  zone,
  size = 'md',
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (typed: string) => void;
  check: OwnNameCheck;
  zone: string;
  size?: InputSize;
  autoFocus?: boolean;
}) {
  const line = ownNameLine(check, zone, currentLocale());
  return (
    <div className={styles.wrap} data-own-name="">
      <div className={styles.input}>
        <Input
          id={id}
          size={size}
          value={value}
          placeholder={OWN_NAME_TEXT.placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          autoFocus={autoFocus}
          invalid={line?.tone === 'bad'}
          aria-describedby={`${id}-check ${id}-privacy`}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s/g, ''))}
        />
        <span className={styles.zone} aria-hidden="true">
          .{zone}
        </span>
      </div>
      <p className={styles.line} id={`${id}-check`} role="status" data-tone={line?.tone ?? 'mut'}>
        {line?.text ?? ''}
      </p>
      <p className={styles.line} id={`${id}-privacy`}>
        {OWN_NAME_TEXT.privacy}
      </p>
    </div>
  );
}
