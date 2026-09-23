// @tus/server catches thrown hook errors by duck-typing `status_code`/`body`
// (confirmed in its own server.js: `error.status_code || ...`), not
// `instanceof`-checking a specific class — an Error subclass carrying the
// same two properties behaves identically at runtime while still satisfying
// `@typescript-eslint/only-throw-error`. Never caught by Nest's own
// DomainExceptionFilter: tus hooks run outside Nest's request pipeline
// (mounted as a raw sub-app via @tus/server's own Server.handle()).
export class TusProtocolError extends Error {
  constructor(
    public readonly status_code: number,
    public readonly body: string,
  ) {
    super(body);
    this.name = 'TusProtocolError';
  }
}
