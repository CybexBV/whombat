import { describe, expect, it } from 'vitest';
import { toApiError } from './client';
import { ApiError, ContractError, InvalidRequestError, NetworkError } from './errors';
import { PROBLEM_WORDS, problemOf, problemText } from './problem';

describe('what a person reads when something didn’t go through', () => {
  it('keeps the server’s own sentence for a refusal', () => {
    const refused = new ApiError(409, 'conflict', 'That name is taken.', null, 'files.rename');
    expect(problemOf(refused)).toEqual({ text: 'That name is taken.', detail: null });
  });

  it('says a bare status, a missing endpoint and a big upload in words, the raw words as the detail', () => {
    const proxy = toApiError('files.rename', 502, '<html>Bad gateway</html>');
    expect(problemOf(proxy)).toEqual({
      text: PROBLEM_WORDS.noAnswer,
      detail: 'Request failed with status 502',
    });
    expect(problemText(new ApiError(404, 'not_found', 'No such endpoint.', null, 'x.y'))).toBe(
      PROBLEM_WORDS.whombatUpdate,
    );
    expect(problemText(toApiError('files.upload', 413, 'Payload Too Large'))).toBe(PROBLEM_WORDS.tooBig);
  });

  it('never shows an endpoint id or a schema’s wording', () => {
    const offline = problemOf(new NetworkError('files.rename', new TypeError('fetch failed')));
    expect(offline.text).toBe(PROBLEM_WORDS.network);
    expect(offline.detail).toContain('files.rename');
    const typed = problemOf(new InvalidRequestError('files.rename', 'body', { name: ['Too big'] }));
    expect(typed.text).toBe(PROBLEM_WORDS.input);
    expect(typed.text).not.toContain('files.rename');
    expect(problemText(new ContractError('files.list', { x: ['bad'] }, {}))).toBe(PROBLEM_WORDS.appUpdate);
  });

  it('falls back to the caller’s words for anything else', () => {
    expect(problemOf(new Error('boom'), 'Couldn’t rename it.')).toEqual({
      text: 'Couldn’t rename it.',
      detail: 'boom',
    });
    expect(problemText(undefined)).toBe(PROBLEM_WORDS.fallback);
  });
});
