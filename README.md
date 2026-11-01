# superagent

A local, always-on Super-agent for macOS and Linux.

## Development

Requires [Bun](https://bun.com) 1.4.4 (pinned in `.bun-version`).

```sh
bun install            # install dependencies
bun run check          # typecheck, lint, format check and tests
bun run typecheck      # tsc (TypeScript 7)
bun run lint           # oxlint, with type-aware rules
bun run format         # oxfmt --write; check:format only checks
bun test               # unit tests
bun src/cli.ts --help  # run the CLI from source
```

Run `bun run check` before opening a PR, and list its results in the PR description.
