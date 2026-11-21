import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyCustody } from '../keys/custody';
import {
  appSecretAad,
  connectionTokenAad,
  openAppSecret,
  openConnectionToken,
  sealAppSecret,
  sealConnectionToken,
} from './crypto';
import { isGoogleUrl } from './types';

describe('connector secrets at rest', () => {
  const custody = new KeyCustody(randomBytes(32).toString('base64'));

  it('seal the app secret under connector_app:<provider>', () => {
    expect(appSecretAad('google')).toBe('connector_app:google');
    const stored = sealAppSecret(custody, 'google', 'GOCSPX-secret');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('GOCSPX');
    expect(openAppSecret(custody, 'google', stored)).toBe('GOCSPX-secret');
  });

  it("keep one label for every app secret in connector_apps, a catalog entry's too", () => {
    // Secrets already stored were sealed under this exact label: changing it would leave them unopenable.
    expect(appSecretAad('google')).toBe('connector_app:google');
    expect(appSecretAad('spotify')).toBe('connector_app:spotify');
    const stored = custody.seal('connector_app:spotify', 'app-secret');
    expect(openAppSecret(custody, 'spotify', stored)).toBe('app-secret');
    expect(() => openAppSecret(custody, 'google', stored)).toThrow();
  });

  it('bind tokens to their connection and kind', () => {
    expect(connectionTokenAad('con_a', 'refresh')).toBe('connection:con_a:refresh');
    const stored = sealConnectionToken(custody, 'con_a', 'refresh', '1//refresh');
    expect(openConnectionToken(custody, 'con_a', 'refresh', stored)).toBe('1//refresh');
    expect(() => openConnectionToken(custody, 'con_b', 'refresh', stored)).toThrow();
    expect(() => openConnectionToken(custody, 'con_a', 'access', stored)).toThrow();
  });

  it('do not open under another master key', () => {
    const stored = sealAppSecret(custody, 'google', 'x');
    const other = new KeyCustody(randomBytes(32).toString('base64'));
    expect(() => openAppSecret(other, 'google', stored)).toThrow();
  });
});

describe('Google hosts', () => {
  it('allows only fixed https Google hosts', () => {
    expect(isGoogleUrl('https://gmail.googleapis.com/gmail/v1/users/me/profile')).toBe(true);
    expect(isGoogleUrl('https://oauth2.googleapis.com/token')).toBe(true);
    expect(isGoogleUrl('http://oauth2.googleapis.com/token')).toBe(false);
    expect(isGoogleUrl('https://evil.example/googleapis.com')).toBe(false);
    expect(isGoogleUrl('https://googleapis.com.evil.example/')).toBe(false);
  });
});
