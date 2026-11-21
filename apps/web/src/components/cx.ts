/** Joins truthy class names. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * A CSS module's class for a state: `variantClass(styles, 'dot', 'ok')` → `styles.dotOk` (the modules are built with
 * `localsConvention: 'camelCaseOnly'`, so `.dot_ok` in the file is `dotOk` here; one-whombat-shell.md AP-1277).
 */
export function variantClass(styles: Record<string, string>, base: string, key: string): string | undefined {
  return styles[`${base}${key.charAt(0).toUpperCase()}${key.slice(1)}`];
}
