import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';

/**
 * Sizes, as used in the desktop mock:
 * - `xs`  6×13px, 13.5px text, 9px radius — composer Send
 * - `sm`  7×12px, 13.5px text, 10px radius — inline actions in cards and panes ("Review deploy")
 * - `md`  8×14px, 14px text, 10px radius — header and card actions ("Watch run"); default
 * - `lg`  9×16px, 14px text, 10px radius — agent profile actions ("Message")
 * - `xl`  11×18px, 15px text, 12px radius — page and modal actions ("Add a server", "Decline")
 */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Horizontal padding override in px (the mock widens some primaries: 11×20, 12×22). */
  padX?: number;
  /** Vertical padding override in px (onboarding buttons are 12px tall-padded). */
  padY?: number;
  /** Stretch to the container width. */
  block?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    padX,
    padY,
    block,
    iconStart,
    iconEnd,
    className,
    style,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  const padding =
    padX !== undefined || padY !== undefined
      ? {
          ...(padX !== undefined && { paddingLeft: padX, paddingRight: padX }),
          ...(padY !== undefined && { paddingTop: padY, paddingBottom: padY }),
        }
      : undefined;
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        variant !== 'link' && styles[size],
        block && styles.block,
        className,
      )}
      style={padding ? { ...padding, ...style } : style}
      {...rest}
    >
      {iconStart}
      {children}
      {iconEnd}
    </button>
  );
});

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
}

/** A link that looks like a button (it navigates, e.g. “Open claude.ai to sign in” in a new tab). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'secondary', size = 'md', iconStart, iconEnd, className, children, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cx(styles.button, styles[variant], variant !== 'link' && styles[size], className)}
      {...rest}
    >
      {iconStart}
      {children}
      {iconEnd}
    </a>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (the button only shows an icon). */
  label: string;
  children: ReactNode;
}

/** 32×32 outlined square button (pane close ×). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.iconButton, className)}
      {...rest}
    >
      {children}
    </button>
  );
});
