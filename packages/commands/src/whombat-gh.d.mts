export declare const ARGS_MAX: number;
export declare const ARG_MAX: number;
export declare const FILES_MAX: number;
export declare const INPUT_MAX_BYTES: number;
export declare function inputsOf(args: readonly string[]): { paths: string[]; stdin: boolean };
export declare function quietRefusal(argv: readonly string[]): boolean;
export interface GhStandInRequest {
  args: string[];
  files: { path: string; base64: string }[];
  stdin: string | null;
}
export declare function buildRequest(
  args: readonly string[],
  options?: { cwd?: string; readStdin?: (max: number) => Promise<Buffer> },
): Promise<GhStandInRequest>;
export declare function exchange(
  request: GhStandInRequest,
  env?: Record<string, string | undefined>,
): Promise<
  { reply: { exitCode?: number; stdout?: string; stderr?: string }; error?: undefined } | { error: string }
>;
export declare function main(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<void>;
