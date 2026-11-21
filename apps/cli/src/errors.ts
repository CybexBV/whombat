/** A problem the person can fix; `fix` is the command or step that fixes it. */
export class CliError extends Error {
  override name = 'CliError';
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}
