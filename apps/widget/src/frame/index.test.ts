import { afterEach, expect, it } from 'vitest';

afterEach(() => {
  document.documentElement.removeAttribute('lang');
  document.title = '';
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

it('uses the URL language for the notice when the frame is opened on its own', async () => {
  history.replaceState(null, '', '/embed/v1/frame.html?lang=nl');
  const root = document.createElement('div');
  root.id = 'wb-root';
  document.body.append(root);

  await import('./index');

  expect(document.documentElement.lang).toBe('nl');
  expect(document.title).toBe('Feedbackformulier');
  expect(root.querySelector('.refused')?.textContent).toMatch(/geen feedback/);
  expect(root.querySelector('form')).toBeNull();
});
