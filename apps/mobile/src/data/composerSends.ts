/**
 * The composer's sends, each with its own follow-up: a second message can go before the first one's answer is back (a
 * quick reply, or typing on). A mutation hook's per-call callbacks belong to its latest call only, so the first
 * message's (its chips leaving the box, its new thread opening, its words coming back when it didn't go) never ran;
 * here each send's own promise carries its follow-up. Files already on their way with one message don't go with the
 * next one too.
 */

/** The box's ready files a new message takes: those not already on their way with an earlier one. */
export function filesToSend(ready: readonly string[], onTheirWay: ReadonlySet<string>): string[] {
  return ready.filter((id) => !onTheirWay.has(id));
}

/**
 * Sends one message and runs its own follow-up once it is answered, whatever was sent after it. `files` are on their
 * way (in `onTheirWay`) until then.
 */
export function sendWithFollowUp<V, R>(
  send: (variables: V) => Promise<R>,
  variables: V,
  files: { ids: readonly string[]; onTheirWay: Set<string> },
  then: { done(result: R): void; failed(error: unknown): void },
): void {
  for (const id of files.ids) files.onTheirWay.add(id);
  const settle = () => {
    for (const id of files.ids) files.onTheirWay.delete(id);
  };
  void send(variables).then(
    (result) => {
      settle();
      then.done(result);
    },
    (error: unknown) => {
      settle();
      then.failed(error);
    },
  );
}
