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
 * Neo's two heads carry his bust's suit, added in the handoff copy too (crew.md AP-4224). Hazel's pencil sits behind her
 * ear, Neo's suit has a light edge for dark pages, and the small heads are framed closer, in both copies too
 * (docs/app/decisions/face-motion.md).
 */
const HANDOFF_SHA256: Record<string, string> = {
  'assistant-bust.svg': '0649a5677c54bec7b4e8de9915023b3d089c8f537a409bc79abd447dabb53bf5',
  'assistant-head-small.svg': '01418f54f53bbbab419609a6d8ac90a73f0e9ecbc43376332255e3c3d49eda2a',
  'assistant-head.svg': 'd0db40af10879df67a0a6538c6dccf584985f8996b9b6fa37080cbe197c4f557',
  'associate-bust.svg': '76a623643cc577a497880312cdb50a7ffaed495fe211260d2208ad79db90def1',
  'associate-head-small.svg': 'f82125720a747e4d7ea3b4b289281432f6637aa008654a2bc70da774ea06d772',
  'associate-head.svg': 'a9aa6653567fff3b1a6ba6b3c13fd50624152f201204ca4d2de4d6dfb42f45ce',
  'developer-bust.svg': 'df6faecafd231c1434e39bb8249713bbb53038145ab54a613d37287d06cbc3fe',
  'developer-head-small.svg': 'f57c4c197c595cd12859e99e6b342c33f3edc90a28ee8ba887aee55661c4e621',
  'developer-head.svg': 'aefd4fb30dead237b686cc272bdf4493f917ca5ec387f8c9dbc688005545928f',
  'lead-bust.svg': '1c221fd950e4db9a60c1a520284b27d2b3d3a58d57923b89911663e42f40e946',
  'lead-head-small.svg': '3dfea1070f76029cff93036af12b8a9b1fc8b8c8fea4cc1b7789e7cfe4ee1d26',
  'lead-head.svg': '9abc3714e8de740947d8e44d26e89e5a7bf578ba7070b1dc2b5ac4212a12398c',
  'operator-bust.svg': 'c87977d3bf8f4e02ea99e91d673e0d8fd10cad09a3eaa850052aa7146533550d',
  'operator-head-small.svg': 'f0782f71ec5dd47e72ecb3b07e0aab94e1ce18decfb1f07fd132d4e4f414205a',
  'operator-head.svg': '4448cc48851a781df509b51b25411ad2547fe2677615e34cacd32ab35157dd0b',
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
