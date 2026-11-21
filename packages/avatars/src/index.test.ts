import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_FACES, DEFAULT_AGENT_FACE } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_FACES,
  AVATAR_FILE_STEMS,
  AVATAR_VARIANTS,
  avatarFile,
  avatarVariant,
  DEFAULT_AVATAR_FACE,
  isAvatarFace,
} from './index';
import { AVATAR_URLS, avatarUrl } from './urls';

const SVG_DIR = join(import.meta.dirname, '../svg');

/**
 * The design handoff's files (Whombat docs/design-handoff/whombat-crew/svg, crew.md; were five-agents/svg), byte for
 * byte: no SVGO, no re-export, so the gradient and clip ids and the viewBox survive (FA-06, the crew brief's §2b).
 * Neo's two heads carry his bust's suit, added in the handoff copy too (crew.md AP-4224).
 */
const HANDOFF_SHA256: Record<string, string> = {
  'assistant-bust.svg': '3afae18eddd17a52aac9751e528e9216ad21ca55782bb689f2296808970d8949',
  'assistant-head-small.svg': '86e2460ee7b2b6e926ae394f4d45fcf938223a62e2a1dbeadb475b5bf53001c4',
  'assistant-head.svg': '33b32cfb762d05ab35b36d51a28edfe0f13096fef04526d02577890b1b96c19b',
  'associate-bust.svg': '76a623643cc577a497880312cdb50a7ffaed495fe211260d2208ad79db90def1',
  'associate-head-small.svg': '08587cd510c4b0b57eeeff3ee2bd88477b1ee9277997d5e46251d821cae469f6',
  'associate-head.svg': 'a9aa6653567fff3b1a6ba6b3c13fd50624152f201204ca4d2de4d6dfb42f45ce',
  'developer-bust.svg': 'df6faecafd231c1434e39bb8249713bbb53038145ab54a613d37287d06cbc3fe',
  'developer-head-small.svg': 'bbb7446d2f296c0e4d5aac59b3ab82790b1b2e71de8b865f44288c10a5446b90',
  'developer-head.svg': 'aefd4fb30dead237b686cc272bdf4493f917ca5ec387f8c9dbc688005545928f',
  'lead-bust.svg': '1c221fd950e4db9a60c1a520284b27d2b3d3a58d57923b89911663e42f40e946',
  'lead-head-small.svg': '38b92421a18e1e83de39aba60731883d92abcf9af73fc3ac4542781b376337d2',
  'lead-head.svg': '9abc3714e8de740947d8e44d26e89e5a7bf578ba7070b1dc2b5ac4212a12398c',
  'operator-bust.svg': '68ad11f94e02b599ab97982f5d02a7717766e984f7d03440eb227b340fb62a41',
  'operator-head-small.svg': 'd7e781eb1f1780fb1155da9fc97522ee9f0397d283fbd35c96519e631bfa720a',
  'operator-head.svg': '454b29d50baa83618ecba5b5942431dcb60012abb980c024a568d8809e37c43c',
};

describe('the avatar files', () => {
  it('are the fifteen files of the handoff, unchanged', () => {
    const files = readdirSync(SVG_DIR).sort();
    expect(files).toEqual(Object.keys(HANDOFF_SHA256).sort());
    for (const file of files) {
      const sha = createHash('sha256')
        .update(readFileSync(join(SVG_DIR, file)))
        .digest('hex');
      expect(sha, file).toBe(HANDOFF_SHA256[file]);
    }
  });

  it('are plain SVG on a 512 viewBox: no script, filter or mask', () => {
    for (const file of readdirSync(SVG_DIR)) {
      const svg = readFileSync(join(SVG_DIR, file), 'utf8');
      expect(svg, file).toMatch(/^<svg [^>]*viewBox="0 0 512 512"/);
      expect(svg, file).not.toMatch(/<(script|filter|mask|foreignObject)\b/);
    }
  });

  it('has one URL per face and variant, each its own file', () => {
    expect(Object.keys(AVATAR_URLS)).toEqual([...AVATAR_FACES]);
    for (const face of AVATAR_FACES)
      for (const variant of AVATAR_VARIANTS)
        expect(AVATAR_URLS[face][variant]).toMatch(`${AVATAR_FILE_STEMS[face]}-${variant}.svg`);
  });
});

describe('avatarVariant (FA-07)', () => {
  it('picks the bust from 40px, the head from 25px and the small head at 24px and below', () => {
    expect(avatarVariant(160)).toBe('bust');
    expect(avatarVariant(40)).toBe('bust');
    expect(avatarVariant(39)).toBe('head');
    expect(avatarVariant(25)).toBe('head');
    expect(avatarVariant(24)).toBe('head-small');
    expect(avatarVariant(16)).toBe('head-small');
  });

  it('honours a forced crop above 24px only', () => {
    expect(avatarVariant(32, 'bust')).toBe('bust');
    expect(avatarVariant(64, 'head')).toBe('head');
    expect(avatarVariant(24, 'bust')).toBe('head-small');
    expect(avatarVariant(20, 'head')).toBe('head-small');
  });
});

describe('the faces (OA-08)', () => {
  it('are the contracts’ five faces and default (core, pinned)', () => {
    expect([...AVATAR_FACES]).toEqual([...AGENT_FACES]);
    expect(DEFAULT_AVATAR_FACE).toBe(DEFAULT_AGENT_FACE);
    expect(isAvatarFace('neo')).toBe(true);
    expect(isAvatarFace('operator')).toBe(false);
  });

  it('each wear their own drawing’s files', () => {
    expect(new Set(Object.values(AVATAR_FILE_STEMS)).size).toBe(AVATAR_FACES.length);
    expect(avatarFile('dusty', 32)).toBe('associate-head.svg');
    expect(avatarFile('skipper', 16)).toBe('lead-head-small.svg');
    expect(avatarUrl('hazel', 160)).toBe(AVATAR_URLS.hazel.bust);
  });
});
