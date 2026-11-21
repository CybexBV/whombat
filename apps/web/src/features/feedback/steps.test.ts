/** The integration page's steps (AP-401): every settings field on one step, problems filtered and ordered by step. */
import { describe, expect, it } from 'vitest';
import { emptyForm, type FieldKey, LIMIT_KEYS, validateForm } from './settingsForm';
import { errorsIn, firstStepWithErrors, hasAdvancedErrors, isAdvanced, STEPS, stepOf } from './steps';

describe('integration steps', () => {
  it('are Name & site, Where reports go, Widget and Install, in that order', () => {
    expect(STEPS.map((s) => s.title)).toEqual(['Name & site', 'Where reports go', 'Widget', 'Install']);
  });

  it('put every field on a settings step, privacy and limits under Widget', () => {
    const on: Record<string, FieldKey[]> = {
      site: ['name', 'productLabel', 'allowedOrigins'],
      reports: ['agentId', 'repoId', 'projectContext', 'handoffAgentId'],
      widget: [
        'reportTypes',
        'theme',
        'position',
        'launcher',
        'launcherLabel',
        'privacyUrl',
        'contactFields',
        'redactPaths',
        'contextKeys',
        'retentionDays',
        ...LIMIT_KEYS.map((k) => `limits.${k}` as const),
      ],
    };
    for (const [step, keys] of Object.entries(on)) for (const key of keys) expect(stepOf(key)).toBe(step);
    expect(isAdvanced('limits.reportsPerHour')).toBe(true);
    expect(isAdvanced('retentionDays')).toBe(true);
    expect(isAdvanced('privacyUrl')).toBe(false);
  });

  it('show a step’s own problems and send a refused form back to its first step with one', () => {
    const v = validateForm({ ...emptyForm(), launcherLabel: '' });
    expect(v.ok).toBe(false);
    const errors = v.ok ? {} : v.errors;
    expect(Object.keys(errorsIn(errors, ['site'])).sort()).toEqual([
      'allowedOrigins',
      'name',
      'productLabel',
    ]);
    // No channel to choose any more (one-agent.md AP-4936).
    expect(Object.keys(errorsIn(errors, ['reports']))).toEqual([]);
    expect(Object.keys(errorsIn(errors, ['widget']))).toEqual(['launcherLabel']);
    expect(firstStepWithErrors(errors)).toBe('site');
    expect(firstStepWithErrors({ launcherLabel: ['x'], agentId: ['y'] })).toBe('reports');
    expect(firstStepWithErrors({})).toBeNull();
    expect(hasAdvancedErrors({ 'limits.reportsPerDay': ['x'] })).toBe(true);
    expect(hasAdvancedErrors({ name: ['x'] })).toBe(false);
  });
});
