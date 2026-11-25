import { expect } from 'vitest';

/**
 * A service's own sign-in field is kept from Safari's AutoFill and password managers, whose fill menus take the focus
 * from the box just clicked: no login autocomplete, and the attributes the password managers leave alone.
 */
export function expectNotALogin(field: HTMLElement) {
  expect(field.getAttribute('autocomplete')).not.toMatch(/^(username|current-password|email|on)?$/);
  expect(field.hasAttribute('data-1p-ignore')).toBe(true);
  expect(field.getAttribute('data-lpignore')).toBe('true');
  expect(field.hasAttribute('data-bwignore')).toBe(true);
  expect(field.getAttribute('data-form-type')).toBe('other');
}
