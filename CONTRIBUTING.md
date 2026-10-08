# Contributing

Thanks for helping improve Log Arithmic. The project targets Bun and TypeScript and
keeps its first release deliberately small and self-hostable.

## Development

1. Install Bun (see [bun.sh](https://bun.sh)).
2. Run `bun install`.
3. Optionally copy `.env.example` to `.env`; local development generates an
   admin token beside the SQLite database if one is not configured.
4. Start the API with `bun run dev`; start the dashboard with `bun run dashboard:dev`.
5. Run `bun test`, `bun run typecheck`, and `bun run dashboard:build` before opening a PR.

Please include tests for behavior changes. Keep changes focused, avoid adding
infrastructure before it is needed, and never commit real API keys or local
database files.

## Releases

Log Arithmic follows semantic versioning. The current development version is `0.1.0`;
while the major version is zero, breaking changes may occur between minor
releases. Release notes belong in `CHANGELOG.md`.
