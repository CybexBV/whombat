/**
 * For the apps' test setups: a fake answer the app had to leave something out of (a list item, or a security view it
 * couldn't read) means the fake no longer matches the contract, so the test fails. A test about what the app shows
 * then says so with `expectLeftOut()`. Answers that don't match even tolerantly already throw in tests
 * (`validateResponses`).
 */
import { afterEach } from 'vitest';
import { leftOut } from '../tolerant';

let expected = false;

/** For a test about what the app shows when an answer has something only a newer app can read. */
export function expectLeftOut(): void {
  expected = true;
}

/** Registers the check after every test of the file (call it once from a setup file). */
export function failOnLeftOut(): void {
  afterEach(() => {
    const left = leftOut.get();
    const allowed = expected;
    leftOut.reset();
    expected = false;
    if (!allowed && (left.items > 0 || left.needsNewer))
      throw new Error(
        `A fake answer doesn't match the contract: the app left out ${left.items} item(s)${left.needsNewer ? ' and could not read a security view' : ''}. Fix the fake, or call expectLeftOut() in a test about it.`,
      );
  });
}
