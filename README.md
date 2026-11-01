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
bun src/cli.ts                # open the terminal UI; prints the status when piped
bun src/cli.ts daemon         # run the agent in the foreground; Ctrl-C stops it
bun src/cli.ts status         # print its status; non-zero exit when it isn't running
bun src/cli.ts status --json  # the raw feed snapshot
```

The terminal UI connects to the daemon for the same data folder and reconnects by itself when it isn't running. It picks a light or dark theme from the terminal's background; press `?` for its keys.

The daemon keeps everything in one data folder, `~/.superagent` unless `SUPERAGENT_HOME` is set: `config.json`, the API `token`, the socket `agent.sock`, the lock `daemon.pid`, the SQLite state `state.db` and `daemon.log`. Clients talk HTTP over the socket, sending `Authorization: Bearer <token>` and `Superagent-Protocol: 1`:

```sh
curl -N --unix-socket ~/.superagent/agent.sock \
  -H "Authorization: Bearer $(cat ~/.superagent/token)" -H 'Superagent-Protocol: 1' \
  http://superagent/v1/feed
```

## Configuration

The agent runs on Particle's `particle-1` model, the only model it will ever support; there is nothing to choose. The daemon reads its Particle API key from `PARTICLE_API_KEY` (Bun also loads it from a `.env` file), or else from `particleApiKey` in `config.json`. Without a key it still runs, but the model shows as paused and console messages wait in the Router's mailbox. It talks to `https://api.particle.ai/v1` unless `PARTICLE_BASE_URL` names another endpoint, such as the US-only `https://us.api.particle.ai/v1` or a local fake server for testing.

## The Router

Console messages go to the Router, one persistent model session that decides what to do and answers through a `reply` tool (at most 100 words in the console). Messages that arrive while it's deciding join the same batch. Its state is on the feed as `router` lines, every model call is recorded in `model_calls` with usage and an estimated cost, and Particle errors show in the model's health: account errors pause the Router (retried every 2 minutes), other errors back off from 30 seconds to 10 minutes. ## Tasks

Real work goes to tasks. The Router starts one with `start_task`, which gives it a four-character handle such as `t97c` and a Worker: a model session with shell and file tools that works in `tasks/<handle>/work` inside the data folder. A command runs with bash in that folder, in its own process group, with an environment built from an allowlist, so the Particle key never reaches it. After 30 seconds it keeps running in the background and the Worker hears when it ends. At most `maxWorkingTasks` tasks (default 4) work at once, and at most 5 Worker model calls run at once, so one is always left for the Router.

Tasks in a repository work in their own git worktree, `worktrees/<repo>/<handle>` in the data folder, on a branch `superagent/<handle>` from `origin/<default branch>` (or the repository's `HEAD` when there's no origin or the fetch fails). Repositories are listed in `config.json` as `{ "name", "path" }`; when the list is empty and you start `superagent daemon` inside a repository, that one is added. Edits show as steps with a diff and `+N −M` counts. Worktrees of tasks that ended over 7 days ago are removed at startup and daily (their branches stay), and command logs older than 30 days are deleted.

From the TUI or `curl`, the `send_note`, `answer_question`, `stop_task` and `resume_tasks` actions reach a task, and `GET /v1/tasks/<handle>` returns its steps, conversation and report. After a crash, commands that were running are killed and their Workers told; active tasks carry on.

## The sandbox

Every Worker command runs in a sandbox, through [sandbox-runtime](https://github.com/anthropics/sandbox-runtime): Seatbelt (`/usr/bin/sandbox-exec`) on macOS, and bubblewrap, socat and ripgrep on Linux. A command can write only in its working folder and its task's `tasks/<handle>/tmp` (its `TMPDIR`). Your home folder is hidden apart from toolchain folders (`~/.bun`, `~/.cargo`, `~/.nvm`, `~/go` and the like, plus home folders on your login `PATH` and any listed in `sandboxReadPaths` in `config.json`), and so are the data folder and your repositories' checkouts; credentials such as `~/.ssh`, `~/.aws` and `~/.config/gh` are never readable. In a worktree, `.git` is read-only: `git status`, `diff` and `log` work, and the Worker commits and pushes its own branch with host-side `commit` and `push` tools. The network reaches the main package registries over HTTPS, plus hosts you allow for that task when the Worker asks with `request_host` (answer "Allow"); GitHub, GitLab, Slack and similar hosts are never reachable.

If the sandbox can't start (bubblewrap or socat missing, user namespaces blocked, AppArmor on Ubuntu 24.04), commands are refused and the health screen shows the problem with the command that fixes it; restart the agent afterwards.
