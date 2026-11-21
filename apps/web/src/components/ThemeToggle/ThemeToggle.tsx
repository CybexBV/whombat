import { useTheme } from '../../app/theme';
import { cx } from '../cx';
import styles from './ThemeToggle.module.css';

/**
 * Sidebar header theme switch: a small mono pill labelled with the theme it switches to
 * ("Dark" in light mode, "Light" in dark mode), as in the mock.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'Light' : 'Dark';
  return (
    <button
      type="button"
      className={cx(styles.toggle, className)}
      onClick={toggleTheme}
      aria-label={`Switch to ${next.toLowerCase()} theme`}
    >
      {next}
    </button>
  );
}
