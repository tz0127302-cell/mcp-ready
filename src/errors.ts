export class McpReadyError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "McpReadyError";
    this.exitCode = exitCode;
  }
}
