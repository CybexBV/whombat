/** Shared test fixtures (not part of any bundle). */
import type { WidgetContext } from '../shared/protocol';
import type { PublicConfig } from './config';

export const CONFIG: PublicConfig = {
  productLabel: 'Shop',
  reportTypes: ['bug', 'feature'],
  theme: 'auto',
  position: 'bottom-right',
  launcher: 'floating',
  launcherLabel: 'Feedback',
  privacyUrl: 'https://shop.example.com/privacy',
  contactFields: { name: 'optional', email: 'optional' },
  attachments: { max: 2, maxBytes: 1024 * 1024, types: ['image/png', 'image/jpeg'] },
  text: { description: 50, expected: 20, steps: 20 },
  redactPaths: ['/customers/*'],
  contextKeys: ['plan'],
  trail: false,
  reporters: false,
};

export const CONTEXT: WidgetContext = {
  page: { url: 'https://shop.example.com/customers/acme/invoices', title: 'Invoices' },
  browser: {
    name: 'Firefox 140 · Linux',
    language: 'nl-NL',
    viewport: { width: 1280, height: 720 },
    timeZone: 'Europe/Amsterdam',
  },
  app: { version: '1.4.2', environment: 'production', build: null },
  custom: { plan: 'pro', secret: 'not allowlisted' },
  references: ['req_1'],
};
