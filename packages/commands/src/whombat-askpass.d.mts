export const ASKPASS_DIR: string;
export function askpassAnswer(prompt: string, read: (alias: string) => string): string | null;
export function main(argv?: string[], dir?: string): void;
