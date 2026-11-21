import type { Decorator, Preview } from '@storybook/react-vite';
import { isThemeName } from '@whombat/tokens';
import '../src/app/global.css';
import { applyTheme, ThemeProvider, writeStoredTheme } from '../src/app/theme';
import { ToastProvider } from '../src/components/Toast';

/**
 * Light/dark toolbar toggle. Sets `data-theme` on <html> (the page background follows `--bg` from
 * global.css) and remounts the ThemeProvider with that theme as the stored choice.
 */
const withTheme: Decorator = (Story, context) => {
  const theme = isThemeName(context.globals.theme) ? context.globals.theme : 'light';
  writeStoredTheme(theme);
  applyTheme(theme);
  return (
    <ThemeProvider key={theme}>
      <ToastProvider>
        <Story />
      </ToastProvider>
    </ThemeProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    controls: { expanded: true },
  },
};

export default preview;
