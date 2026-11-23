/**
 * Arriving and leaving without Postgres (docs/decisions/findmy-connection.md): how a read changes the places a
 * listened Find My connection keeps, and a change's words for its run. Made-up names only.
 */
import { describe, expect, it } from 'vitest';
import { findMyPersonId } from './findmy';
import { type KeptPlace, placeChangeScope, placeChanges, placeChangeText } from './findmy-places';

const MARA = findMyPersonId('Mara Visser');
const RUBEN = findMyPersonId('Ruben Visser');
const AT = new Date('2026-11-23T10:00:00.000Z');
const BEFORE = new Date('2026-11-23T09:00:00.000Z');

const kept = (person: string, name: string, place: string): KeptPlace => ({
  person,
  name,
  place,
  since: BEFORE,
});

describe('a read against the kept places', () => {
  it('keeps a first place without a change: a first read invents no arrival', () => {
    const { changes, keep } = placeChanges([], [{ id: MARA, name: 'Mara Visser', place: 'Lelystad' }], AT);
    expect(changes).toEqual([]);
    expect(keep).toEqual([{ person: MARA, name: 'Mara Visser', place: 'Lelystad', since: AT }]);
  });

  it('is a change when the place differs, kept from then', () => {
    const { changes, keep } = placeChanges(
      [kept(MARA, 'Mara Visser', 'Lelystad')],
      [{ id: MARA, name: 'Mara Visser', place: 'Home' }],
      AT,
    );
    expect(changes).toEqual([{ person: MARA, name: 'Mara Visser', from: 'Lelystad', to: 'Home' }]);
    expect(keep.map((k) => [k.place, k.since])).toEqual([['Home', AT]]);
  });

  it('writes nothing when the place is the same without case or spaces', () => {
    expect(
      placeChanges(
        [kept(MARA, 'Mara Visser', 'Home')],
        [{ id: MARA, name: 'Mara Visser', place: ' home ' }],
        AT,
      ),
    ).toEqual({ changes: [], keep: [] });
  });

  it('keeps the last place of someone Find My has none for now', () => {
    const { changes, keep } = placeChanges(
      [kept(MARA, 'Mara Visser', 'Home')],
      [
        { id: MARA, name: 'Mara Visser', place: null },
        { id: RUBEN, name: 'Ruben Visser', place: '' },
      ],
      AT,
    );
    expect(changes).toEqual([]);
    expect(keep).toEqual([]);
  });

  it('reads each person once and leaves out an id that isn’t Find My’s', () => {
    const { keep } = placeChanges(
      [],
      [
        { id: MARA, name: 'Mara Visser', place: 'Home' },
        { id: MARA, name: 'Mara Visser', place: 'Work' },
        { id: 'Mara', name: 'Mara', place: 'Home' },
      ],
      AT,
    );
    expect(keep.map((k) => [k.person, k.place])).toEqual([[MARA, 'Home']]);
  });
});

describe('a change in words', () => {
  it('says where someone is now and was, at a place of their own and in a town', () => {
    const text = placeChangeText({ name: 'Mara Visser', from: 'Lelystad', to: 'Home' });
    expect(text).toContain('Mara Visser');
    expect(text).toContain('at Home');
    expect(text).toContain('in Lelystad');
    expect(placeChangeText({ name: 'Ruben Visser', from: null, to: 'Work' })).not.toContain('was');
  });

  it('is the run’s scope: text, the person’s name, the place and where from', () => {
    const scope = placeChangeScope({
      connectionId: 'con_findmy01',
      person: MARA,
      name: 'Mara Visser',
      from: 'Lelystad',
      to: 'Home',
    });
    expect(scope).toMatchObject({
      kind: 'findmy',
      person: 'Mara Visser',
      personId: MARA,
      place: 'Home',
      from: 'Lelystad',
    });
    expect(scope.text).toContain('Home');
    // Never a street or a spot on a map.
    expect(Object.keys(scope)).not.toContain('address');
    expect(Object.keys(scope)).not.toContain('location');
  });
});
