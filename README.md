# superagent

A local, always-on Super-agent for macOS and Linux.

## Development

Requires [Bun](https://bun.com) 1.4.4 (pinned in `.bun-version`).

```sh
bun install            # install dependencies
bun run check          # typecheck, lint and format check
bun run typecheck      # tsc (TypeScript 7)
bun run lint           # oxlint, with type-aware rules
bun run format         # oxfmt --write; check:format only checks
bun src/cli.ts --help  # run the CLI from source
```

Run `bun run check` before opening a PR, and list its results in the PR description.

## Configuration

The model client reads its API key from `PARTICLE_API_KEY` (Bun also loads it from a `.env` file). It talks to `https://api.particle.ai/v1` unless given another `baseUrl`, such as the US-only `https://us.api.particle.ai/v1`.
