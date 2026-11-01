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

## Running

```sh
bun src/cli.ts daemon         # run the agent in the foreground; Ctrl-C stops it
bun src/cli.ts status         # print its status; non-zero exit when it isn't running
bun src/cli.ts status --json  # the raw feed snapshot
```

The daemon keeps everything in one data folder, `~/.superagent` unless `SUPERAGENT_HOME` is set: `config.json`, the API `token`, the socket `agent.sock`, the lock `daemon.pid`, the SQLite state `state.db` and `daemon.log`. Clients talk HTTP over the socket, sending `Authorization: Bearer <token>` and `Superagent-Protocol: 1`:

```sh
curl -N --unix-socket ~/.superagent/agent.sock \
  -H "Authorization: Bearer $(cat ~/.superagent/token)" -H 'Superagent-Protocol: 1' \
  http://superagent/v1/feed
```

## Configuration

The model client reads its API key from `PARTICLE_API_KEY` (Bun also loads it from a `.env` file). It talks to `https://api.particle.ai/v1` unless given another `baseUrl`, such as the US-only `https://us.api.particle.ai/v1`.
