import { createElement, forwardRef, type HTMLAttributes, type LabelHTMLAttributes } from 'react';
import { cx } from '../cx';
import styles from './SectionLabel.module.css';

export type SectionLabelTone = 'mut' | 'warn' | 'ok' | 'bad' | 'brand' | 'ink';

export interface SectionLabelProps extends HTMLAttributes<HTMLElement> {
  /** Element to render: `span` (default), a heading, or `label` for form fields (pass `htmlFor`). */
  as?: 'span' | 'div' | 'label' | 'h2' | 'h3' | 'h4' | 'legend';
  /** `md` 11px (cards, panes, modals), `sm` 10.5px (sidebar). */
  size?: 'md' | 'sm';
  tone?: SectionLabelTone;
  htmlFor?: LabelHTMLAttributes<HTMLLabelElement>['htmlFor'];
}

/** DM Mono 500 uppercase label with .05em tracking (`CHANNELS`, `PLAN · 4 STEPS`, `KEYS`). */
export const SectionLabel = forwardRef<HTMLElement, SectionLabelProps>(function SectionLabel(
  { as = 'span', size = 'md', tone = 'mut', className, ...rest },
  ref,
) {
  return createElement(as, {
    ref,
    className: cx(styles.label, styles[size], styles[tone], className),
    ...rest,
  });
});
