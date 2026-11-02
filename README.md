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
bun run e2e            # drive a real daemon end to end against a fake Particle server
```

Run `bun run check` before opening a PR, and list its results in the PR description.

There are no unit tests. `e2e/` drives the real daemon the way the TUI does: `e2e/harness.ts` starts `superagent daemon --script-channel` on a fresh `/tmp/sa-…` data folder and talks to it over its socket, and `e2e/fake-particle.ts` is a Particle server whose answers each scenario scripts, told apart by `prompt_cache_key`. `e2e/threads.ts` covers thread ownership, filtering, release and reopen, and questions answered on a thread; it prints one line per check and exits non-zero if any fails. Set `E2E_VERBOSE=1` to see the daemon's log and `E2E_KEEP=1` to keep its data folder.

## Running

```sh
bun src/cli.ts                # open the terminal UI; prints the status when piped
bun src/cli.ts daemon         # run the agent in the foreground; Ctrl-C stops it
bun src/cli.ts status         # print its status; non-zero exit when it isn't running
bun src/cli.ts status --json  # the raw feed snapshot
bun src/cli.ts login particle # ask for your Particle API key, check it and save it
```

The terminal UI connects to the daemon for the same data folder and reconnects by itself when it isn't running. It picks a light or dark theme from the terminal's background; press `?` for its keys.

The daemon keeps everything in one data folder that only you can read, `~/.superagent` unless `SUPERAGENT_HOME` is set: `config.json` (mode `0600`), the Particle key `particle-key` (mode `0600`), the socket `agent.sock`, the lock `daemon.pid`, the SQLite state `state.db` and `daemon.log`. Clients talk HTTP over the socket, sending `Superagent-Protocol: 1`:

```sh
curl -N --unix-socket ~/.superagent/agent.sock -H 'Superagent-Protocol: 1' \
  http://superagent/v1/feed
```

## The script channel

`superagent daemon --script-channel` turns on `POST /v1/events`, which injects a message on a test channel, `script`, the same way GitHub and Slack will arrive. It's for tests and development:

```sh
curl --unix-socket ~/.superagent/agent.sock -H 'Superagent-Protocol: 1' \
  http://superagent/v1/events -d '{"externalId":"evt-17","thread":{"key":"support/77","title":"#support","url":null},
  "author":{"id":"u-bob","name":"bob","isBot":false},"text":"@superagent export is broken","mentionsAgent":true}'
```

The thread becomes `script:support/77`. A message on a thread a task owns goes straight to that task's Worker, and answers its open question if it has one. Otherwise bots' messages and messages that don't mention the agent are filtered, and the rest go to the Router. `GET /v1/threads/:id` shows a thread, its owner and its messages.

## Configuration

The agent runs on Particle's `particle-1` model, the only model it will ever support; there is nothing to choose. `superagent login particle` asks for your Particle API key without echoing it (or reads it from a pipe), checks it with `GET /v1/models`, which spends no tokens, and saves it to `particle-key` in the data folder, written in one rename with mode `0600`; a key Particle rejects isn't saved. `PARTICLE_API_KEY` (Bun also loads it from a `.env` file) overrides the file. The daemon re-reads the file every 2 seconds and before each model call, so a new key is used without a restart: a model paused for a missing key resumes within seconds, and one paused on a rejected key at its next retry. Earlier versions kept the key as `particleApiKey` in `config.json`; the daemon moves it to the key file when it starts, unless the file already has a key, and removes it from `config.json`. `superagent status` and the health screen say where the key comes from, never the key. Without a key the agent still runs, but the model shows as paused and console messages wait in the Router's mailbox. It talks to `https://api.particle.ai/v1` unless `PARTICLE_BASE_URL` names another endpoint, such as the US-only `https://us.api.particle.ai/v1` or a local fake server for testing.

## GitHub

GitHub is optional: the agent needs only a Particle key. It uses your own `gh` login, reading the token with `gh auth token` into memory each time it needs it (at start, hourly, after GitHub rejects it, and every minute while GitHub is off); the agent never stores it, and keeps it out of commands, the model, logs, the feed and the TUI like its other keys. Without `gh` installed and logged in, GitHub is off: the health screen and `superagent status` say how to turn it on (install `gh`, run `gh auth login`), it isn't counted as a problem, and it turns on by itself within a minute of logging in. `"github": false` in `config.json` keeps it off. When it's on, the agent checks your login, the `repo` scope, and that you can push to each configured repository, whose GitHub name comes from its `origin` remote or a `"githubRepo": "owner/name"` on its entry. For tests, `SUPERAGENT_GH`, `SUPERAGENT_GITHUB_API_URL` and `SUPERAGENT_GITHUB_POLL_MS` replace the `gh` executable, the API's address and the one-minute check.

## The Router

Console messages go to the Router, one persistent model session that decides what to do and answers through a `reply` tool (at most 100 words in the console). Messages that arrive while it's deciding join the same batch. Its state is on the feed as `router` lines, every model call is recorded in `model_calls` with usage and an estimated cost, and Particle errors show in the model's health: account errors pause the Router (retried every 2 minutes), other errors back off from 30 seconds to 10 minutes. ## Tasks

Real work goes to tasks. The Router starts one with `start_task`, which gives it a four-character handle such as `t97c` and a Worker: a model session with shell and file tools that works in `tasks/<handle>/work` inside the data folder. A command runs with bash in that folder, in its own process group, with the daemon's environment minus the agent's own keys, and your login shell's `PATH`. If a command's output, a file the Worker reads or an edit's diff contains a Particle key the agent has read (from the environment, the key file or `config.json`, including one since replaced), it shows as `[redacted]` to the Worker, the TUI and the log. After 30 seconds it keeps running in the background and the Worker hears when it ends. At most `maxWorkingTasks` tasks (default 4) work at once, and at most 5 Worker model calls run at once, so one is always left for the Router.

Tasks in a repository work in their own git worktree, `worktrees/<repo>/<handle>` in the data folder, on a branch `superagent/<handle>` from `origin/<default branch>` (or the repository's `HEAD` when there's no origin or the fetch fails). Repositories are listed in `config.json` as `{ "name", "path" }`; when the list is empty and you start `superagent daemon` inside a repository, that one is added. Edits show as steps with a diff and `+N −M` counts. If git can't resolve `user.name` or `user.email` for the configured repositories at startup, health shows a warning that Worker commits will fail, with the `git config --global` commands that fix it. Worktrees of tasks that ended over 7 days ago are removed at startup and daily (their branches stay), and command logs older than 30 days are deleted.

From the TUI or `curl`, the `send_note`, `answer_question`, `stop_task` and `resume_tasks` actions reach a task, and `GET /v1/tasks/<handle>` returns its steps, conversation and report. After a crash, commands that were running are killed and their Workers told; active tasks carry on.

## The sandbox

Worker commands run through [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) so a mistaken command can't change files outside its task: Seatbelt (`/usr/bin/sandbox-exec`) on macOS, and bubblewrap on Linux, which also needs socat and ripgrep installed. A command can write only in its working folder, its task's `tasks/<handle>/tmp` (its `TMPDIR`), `/tmp`, the usual package and tool caches that exist (`~/.cache`, created if missing, `~/.npm`, `~/.bun/install/cache`, `~/go/pkg/mod`, `~/.cargo/registry` and the like, `~/Library/Caches` on macOS, or wherever their environment variables point; a cache path that can't be used is skipped and logged) and, in a worktree, the repository's git folder, so `git commit` and package installs work as usual. Reads, the network and Unix sockets are open. The `write_file` and `edit_file` tools likewise write only inside the working folder, after following symlinks. The sandbox is optional: if it can't start, commands run unsandboxed, and the health screen and `superagent status` show a warning with the cause and the command that fixes it. Restart the agent afterwards and it's back on.
