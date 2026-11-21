import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)', '../../../packages/*/src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  // The HTML preview frame (public/sandbox/, AP-320) for the rich message stories.
  staticDirs: [{ from: '../public/sandbox', to: '/sandbox' }],
  // TypeScript 7 has no JS compiler API, so use the Babel-based docgen.
  typescript: { reactDocgen: 'react-docgen' },
  core: { disableTelemetry: true },
};

export default config;
