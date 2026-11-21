import type { ComponentProps } from 'react';
import styles from './ui.module.css';

export function Button({
  kind = 'primary',
  className,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { kind?: 'primary' | 'secondary' | 'danger' | 'quiet' }) {
  return <button type={type} className={[styles.button, styles[kind], className].join(' ')} {...rest} />;
}
