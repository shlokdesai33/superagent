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

The agent runs on Particle's `particle-1` model, the only model it will ever support; there is nothing to choose. The daemon reads its Particle API key from `PARTICLE_API_KEY` (Bun also loads it from a `.env` file), or else from `particleApiKey` in `config.json`. Without a key it still runs, but the model shows as paused and console messages wait in the Router's mailbox. It talks to `https://api.particle.ai/v1` unless `PARTICLE_BASE_URL` names another endpoint, such as the US-only `https://us.api.particle.ai/v1` or a local fake server for testing.

## The Router

Console messages go to the Router, one persistent model session that decides what to do and answers through a `reply` tool (at most 100 words in the console). Messages that arrive while it's deciding join the same batch. Its state is on the feed as `router` lines, every model call is recorded in `model_calls` with usage and an estimated cost, and Particle errors show in the model's health: account errors pause the Router (retried every 2 minutes), other errors back off from 30 seconds to 10 minutes. Starting and running tasks arrives in the next build step; until then the task tools answer "not available".
