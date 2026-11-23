/**
 * Find My as a connection of its own (docs/implementation/macos/findmy-connection.md): its catalog entry and check, a
 * select's own choices, the reason it can't be added yet, the tab that names its Mac, and its signed event.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_CONNECTABLE,
  CatalogCheck,
  CatalogEntryStatus,
  CatalogField,
  catalogEntry,
  fieldProblem,
  fieldsFor,
  fieldsProblems,
  isAgentConnection,
  resolveBaseUrl,
} from './connections-catalog.js';
import {
  FIND_MY_BACKGROUND_CHOICES,
  FIND_MY_LISTENED_MS,
  FIND_MY_PLACE_CHANGED,
  FindMyPeopleArgs,
  FindMyPlaceChanged,
  findMyBackgroundMinutes,
  findMyPlaceKey,
  HOST_FIND_MY_FRESH_MS,
} from './hosts-findmy.js';
import { ThingPageTab } from './thing-page.js';

const findmy = () => {
  const e = catalogEntry('findmy');
  if (!e) throw new Error('no findmy entry');
  return e;
};

describe('the Find My entry', () => {
  it('is connectable, signs in with nothing and has no address of its own', () => {
    const e = findmy();
    expect(CATALOG_CONNECTABLE.some((x) => x.id === 'findmy')).toBe(true);
    expect(isAgentConnection(e)).toBe(true);
    expect(e.name).toBe('Find My');
    expect(e.transport).toBe('rest');
    expect(e.signIn.map((m) => m.kind)).toEqual(['none']);
    expect(e.baseUrl).toBe('whombat-hosts:');
    expect(e.check).toEqual({ kind: 'mac' });
    expect(e.request).toBeNull();
    // Not a web address: nothing is ever sent there.
    expect(resolveBaseUrl(e, {})).toBeNull();
    expect(e.guide.length).toBeGreaterThan(50);
  });

  it('asks which Mac, and how often to read in the background, Off by default', () => {
    const e = findmy();
    expect(fieldsFor(e, 'none').map((f) => [f.id, f.kind])).toEqual([
      ['mac', 'select'],
      ['background', 'select'],
    ]);
    const [mac, background] = fieldsFor(e, 'none');
    expect(mac).toMatchObject({ label: 'Mac', fromService: true, required: true });
    expect(mac?.options).toBeUndefined();
    expect(background?.default).toBe('off');
    expect(background?.options?.map((o) => o.value)).toEqual(['off', '5', '15', '30', '60']);
    expect(background?.options?.[0]?.label).toBe('Off');
    expect(background?.options?.at(-1)?.label).toBe('Every hour');
  });

  it('has one tool that reads, for everyone or one person', () => {
    const tools = findmy().tools;
    expect(tools.map((t) => [t.name, t.access])).toEqual([['findmy_people', 'read']]);
    expect(tools[0]?.description).toContain('2 minutes');
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { person: { type: 'string' } },
    });
    expect(FindMyPeopleArgs.safeParse({}).success).toBe(true);
    expect(FindMyPeopleArgs.parse({ person: ' Mara ' })).toEqual({ person: 'Mara' });
    expect(FindMyPeopleArgs.safeParse({ person: '' }).success).toBe(false);
    expect(FindMyPeopleArgs.safeParse({ person: 'Mara', lat: 1 }).success).toBe(false);
  });

  it('refuses a background value that isn’t one of its choices, and lets the Mac be filled in', () => {
    const e = findmy();
    expect(fieldsProblems(e, 'none', {})).toEqual({});
    expect(fieldsProblems(e, 'none', { mac: 'studio', background: '15' })).toEqual({});
    expect(fieldsProblems(e, 'none', { background: '10' })).toEqual({
      background: 'Pick one of the choices for Read in the background.',
    });
  });
});

describe('a select’s own choices', () => {
  const choices = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  const field = { id: 'pick', label: 'Pick', kind: 'select', required: true, options: choices } as const;

  it('accepts only its choices', () => {
    expect(fieldProblem(field, 'a')).toBeNull();
    expect(fieldProblem(field, ' b ')).toBeNull();
    expect(fieldProblem(field, 'c')).toBe('Pick one of the choices for Pick.');
    expect(fieldProblem(field, '')).toBe('Pick is needed.');
  });

  it('are at least two', () => {
    expect(CatalogField.safeParse(field).success).toBe(true);
    expect(CatalogField.safeParse({ ...field, options: [choices[0]] }).success).toBe(false);
  });
});

describe('the contract around it', () => {
  it('checks through a Mac', () => {
    expect(CatalogCheck.safeParse({ kind: 'mac' }).success).toBe(true);
  });

  it('says an entry needs a Mac first', () => {
    expect(
      CatalogEntryStatus.safeParse({ catalogId: 'findmy', available: false, reason: 'needs_mac' }).success,
    ).toBe(true);
  });

  it('lets a tab name the server it is about', () => {
    expect(ThingPageTab.parse({ key: 'findmy', label: 'Find My', server: 'studio', panels: [] }).server).toBe(
      'studio',
    );
    expect(ThingPageTab.parse({ key: 'activity', label: 'Activity', panels: [] }).server).toBeUndefined();
    expect(ThingPageTab.safeParse({ key: 'findmy', label: 'Find My', server: '', panels: [] }).success).toBe(
      false,
    );
  });

  it('reads in the background as often as chosen, and at least every 15 minutes while listened to', () => {
    expect(FIND_MY_BACKGROUND_CHOICES.map((c) => c.value)).toEqual(['off', '5', '15', '30', '60']);
    expect(['off', '5', '15', '30', '60', '10', undefined].map(findMyBackgroundMinutes)).toEqual([
      null,
      5,
      15,
      30,
      60,
      null,
      null,
    ]);
    expect(FIND_MY_LISTENED_MS).toBe(15 * 60_000);
    expect(FIND_MY_LISTENED_MS).toBeGreaterThan(HOST_FIND_MY_FRESH_MS);
  });

  it('signs a change of place with names and place words only', () => {
    const change = {
      connectionId: 'con_findmy01',
      person: '0123456789ab',
      name: 'Mara Visser',
      from: 'Lelystad',
      to: 'Home',
    };
    expect(FIND_MY_PLACE_CHANGED).toBe('findmy.place_changed');
    expect(FindMyPlaceChanged.parse(change)).toEqual(change);
    expect(FindMyPlaceChanged.safeParse({ ...change, from: null, to: null }).success).toBe(true);
    expect(FindMyPlaceChanged.safeParse({ ...change, person: 'Mara' }).success).toBe(false);
    expect(FindMyPlaceChanged.safeParse({ ...change, address: 'Damrak 1' }).success).toBe(false);
    expect(FindMyPlaceChanged.safeParse({ ...change, to: 'x'.repeat(201) }).success).toBe(false);
  });

  it('compares places without case or spaces', () => {
    expect(findMyPlaceKey(' Home ')).toBe(findMyPlaceKey('home'));
    expect(findMyPlaceKey('Den  Haag')).toBe(findMyPlaceKey('den haag'));
    expect(findMyPlaceKey('Home')).not.toBe(findMyPlaceKey('Work'));
  });
});
