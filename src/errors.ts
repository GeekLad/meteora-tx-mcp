export class TxBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxBuildError";
  }
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1200 ? `${message.slice(0, 1200)}…` : message;
}
