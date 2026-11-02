import { existsSync } from 'node:fs';
import type { Health, Problem } from '../protocol.ts';
import { git } from './git.ts';
import { addSecrets, envWithoutSecrets, redact } from './secrets.ts';
import type { Config } from './setup.ts';
import { type Daemon, health } from './state.ts';

// Test-only overrides, like PARTICLE_BASE_URL: a fake server, a fake gh, and a
// fast tick.
const API_URL = Bun.env.SUPERAGENT_GITHUB_API_URL ?? 'https://api.github.com';
const GH_OVERRIDE = Bun.env.SUPERAGENT_GH;
const TICK_MS = Number(Bun.env.SUPERAGENT_GITHUB_POLL_MS) || 60_000;

const MAX_TICK_MS = 5 * 60_000;
const TOKEN_REREAD_MS = 60 * 60_000;
const GH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 4_000];
const WRITE_SPACING_MS = 1_000;
const SLOW_BELOW = 1_000;
const PAUSE_BELOW = 200;
const OFFLINE_AFTER = 3;
const MAX_PAGES = 10;
const RATE_WAIT_MS = 60_000;
const MAX_RATE_WAIT_MS = 15 * 60_000;

const NOT_INSTALLED =
	"gh isn't installed · install it from cli.github.com, then run gh auth login";
const NOT_LOGGED_IN = "gh isn't logged in · run gh auth login";
const DISABLED =
	'turned off in config.json · remove "github": false to turn it on';
const CHECKING = 'checking your gh login';
const REJECTED = 'GitHub rejected your gh token';
const OFFLINE = "can't reach GitHub · retrying every minute";

/** The GitHub channel as health shows it. */
export type GitHubLive = {
	state: Health['channels'][number]['state'];
	detail: string | null;
	problems: Problem[];
	/** Configured repositories on GitHub, by config name, once the token is checked. */
	repos: Array<{ name: string; fullName: string }>;
	/** Your GitHub login, once the token is checked; for the sign-off. */
	login: string | null;
};

export function initialGitHub(config: Config): GitHubLive {
	return config.github
		? {
				state: 'connecting',
				detail: CHECKING,
				problems: [],
				repos: [],
				login: null,
			}
		: { state: 'off', detail: DISABLED, problems: [], repos: [], login: null };
}

/** A failed reply's first retry: half a tick, so 30 s, doubling from there. */
export function githubRetryMs(): number {
	return TICK_MS / 2;
}

/** Why a `github:` thread can't be used right now, or `null` when GitHub is on. */
export function githubOff(daemon: Daemon): string | null {
	return daemon.github.state === 'off'
		? `GitHub is off (${daemon.github.detail ?? 'not set up'}); tell the operator if they asked for GitHub work`
		: null;
}

export class GitHubError extends Error {
	override name = 'GitHubError';
	/** The HTTP status, or `null` when GitHub couldn't be reached. */
	readonly status: number | null;
	readonly rateLimited: boolean;
	constructor(status: number | null, message: string, rateLimited = false) {
		super(message);
		this.status = status;
		this.rateLimited = rateLimited;
	}
}

export type GitHubResponse = {
	status: number;
	headers: Headers;
	/** `null` for a `304`: unchanged since the `etag` sent. */
	body: unknown;
	etag: string | null;
	/** The next page from the `Link` header, as a path. */
	next: string | null;
};

export type GitHubApi = {
	/**
	 * One request at a time; non-GET requests at least 1 s apart. With `etag`,
	 * an unchanged answer is a `304`, which costs no rate limit. Throws
	 * `GitHubError`.
	 */
	request: (
		method: string,
		path: string,
		options?: { body?: unknown; etag?: string | null },
	) => Promise<GitHubResponse>;
	/**
	 * Every page of a listing, following `Link: rel="next"`, at most 10. The
	 * `etag` applies to the first page; `notModified` means nothing changed.
	 */
	pages: (
		path: string,
		etag?: string | null,
	) => Promise<{ items: unknown[]; etag: string | null; notModified: boolean }>;
};

type Rate = { limit: number; remaining: number; reset: number };

export type GitHubClient = GitHubApi & { stop: () => Promise<void> };

/**
 * Runs the GitHub channel until `stop`: reads the token from `gh auth token`,
 * checks it, and keeps health current. GitHub being unavailable in any way is
 * a health state, never an error.
 */
export function startGitHub(
	daemon: Daemon,
	/** Runs after each successful check, while GitHub is up. */
	poll: (api: GitHubApi) => Promise<void>,
): GitHubClient {
	const stop = new AbortController();
	// Every token read, kept as secrets for the daemon's life.
	const tokens: string[] = [];
	let token: string | null = null;
	let readAt = 0;
	let checked = false;
	let rejected = false;
	let failures = 0;
	let login: string | null = null;
	let repos = 0;
	let repoProblems: Array<Omit<Problem, 'since'>> = [];
	// Set from responses inside closures, so it isn't narrowed to `null` here.
	let rate = null as Rate | null;
	let waitUntil = 0;
	let rateWait = RATE_WAIT_MS;
	let lastWriteAt = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const since = new Map<string, number>();

	const set = (
		state: GitHubLive['state'],
		detail: string | null,
		problems: Array<Omit<Problem, 'since'>> = [],
	) => {
		const stamped = problems.map((problem) => {
			const at = since.get(problem.id) ?? Date.now();
			since.set(problem.id, at);
			return { ...problem, since: at };
		});
		for (const id of since.keys()) {
			if (!problems.some((problem) => problem.id === id)) since.delete(id);
		}
		const current = daemon.github;
		const next: GitHubLive = {
			state,
			detail,
			problems: stamped,
			repos: current.repos,
			login: state === 'off' ? null : current.login,
		};
		if (JSON.stringify(current) === JSON.stringify(next)) return;
		if (current.state !== state) {
			daemon.log('info', 'github channel', { state, detail });
		}
		daemon.github = next;
		daemon.feed.publish({ type: 'health', health: health(daemon) });
	};

	const off = (detail: string) => {
		token = null;
		checked = false;
		rejected = false;
		login = null;
		set('off', detail);
	};

	const up = () => {
		const parts = [
			`@${login ?? '?'} via gh`,
			`${repos} ${repos === 1 ? 'repo' : 'repos'}`,
		];
		const followed = followedCount(daemon);
		if (followed > 0) {
			parts.push(
				`${followed} ${followed === 1 ? 'thread' : 'threads'} followed`,
			);
		}
		if (rate) {
			parts.push(
				`${rate.remaining.toLocaleString('en-US')} of ${rate.limit.toLocaleString('en-US')} API calls left`,
			);
		}
		if (waitUntil > Date.now())
			parts.push(`rate limited until ${clock(waitUntil)}`);
		set('up', parts.join(' · '), repoProblems);
	};

	const down = (detail: string, problem: Omit<Problem, 'since'>) => {
		set('down', detail, [problem, ...repoProblems]);
	};

	const adopt = (fresh: string) => {
		addSecrets(daemon.secrets, [fresh]);
		if (!tokens.includes(fresh)) tokens.push(fresh);
		if (fresh !== token) {
			token = fresh;
			checked = false;
		}
	};

	const read = async () => {
		const result = await readToken(daemon, tokens, stop.signal);
		readAt = Date.now();
		if (result.ok) adopt(result.token);
		return result;
	};

	const send = async (
		method: string,
		path: string,
		options: { body?: unknown; etag?: string | null },
	): Promise<GitHubResponse> => {
		const free = path === '/rate_limit';
		const pausedUntil = Math.max(
			waitUntil,
			!free && rate && rate.remaining < PAUSE_BELOW ? rate.reset * 1000 : 0,
		);
		if (!free && pausedUntil > Date.now()) {
			await sleep(pausedUntil - Date.now(), stop.signal);
		}
		if (method !== 'GET') {
			const gap = lastWriteAt + WRITE_SPACING_MS - Date.now();
			if (gap > 0) await sleep(gap, stop.signal);
		}
		let reread = false;
		for (let attempt = 0; ; attempt++) {
			if (token === null) throw new GitHubError(401, REJECTED);
			const used = token;
			const headers: Record<string, string> = {
				Authorization: `Bearer ${used}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': `superagent/${daemon.agent.version}`,
			};
			if (options.etag) headers['If-None-Match'] = options.etag;
			if (options.body !== undefined)
				headers['Content-Type'] = 'application/json';
			let response: Response;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop
				response = await fetch(`${API_URL}${path}`, {
					method,
					headers,
					...(options.body === undefined
						? {}
						: { body: JSON.stringify(options.body) }),
					signal: AbortSignal.any([
						stop.signal,
						AbortSignal.timeout(REQUEST_TIMEOUT_MS),
					]),
				});
			} catch (error) {
				if (stop.signal.aborted) throw error;
				// Only reads are retried here: a write may have landed, and its
				// caller checks before trying again.
				const delay = method === 'GET' ? RETRY_DELAYS_MS[attempt] : undefined;
				if (delay !== undefined) {
					// oxlint-disable-next-line eslint/no-await-in-loop
					await sleep(delay, stop.signal);
					continue;
				}
				throw new GitHubError(
					null,
					`can't reach GitHub (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			if (method !== 'GET') lastWriteAt = Date.now();
			noteRate(response.headers);
			// oxlint-disable-next-line eslint/no-await-in-loop
			const text = await response.text();
			const { status } = response;
			if (status >= 400 || method !== 'GET') {
				daemon.log(status >= 400 ? 'warn' : 'info', 'github request', {
					method,
					path,
					status,
					request: response.headers.get('x-github-request-id'),
					remaining: rate?.remaining ?? null,
				});
			}

			if (status >= 500) {
				const delay = method === 'GET' ? RETRY_DELAYS_MS[attempt] : undefined;
				if (delay !== undefined) {
					// oxlint-disable-next-line eslint/no-await-in-loop
					await sleep(delay, stop.signal);
					continue;
				}
				throw new GitHubError(status, `GitHub answered ${status}`);
			}
			if (status === 401) {
				// gh may hold a newer token: try it once.
				if (!reread) {
					reread = true;
					// oxlint-disable-next-line eslint/no-await-in-loop
					const fresh = await read();
					if (fresh.ok && fresh.token !== used) continue;
				}
				throw new GitHubError(401, REJECTED);
			}
			if (isRateLimited(response, text)) {
				const retryAfter = Number(response.headers.get('retry-after'));
				const reset = Number(response.headers.get('x-ratelimit-reset'));
				const wait =
					retryAfter > 0
						? retryAfter * 1000
						: response.headers.get('x-ratelimit-remaining') === '0' && reset > 0
							? reset * 1000 - Date.now()
							: rateWait;
				rateWait = Math.min(rateWait * 2, MAX_RATE_WAIT_MS);
				waitUntil = Date.now() + Math.max(1_000, wait);
				throw new GitHubError(
					status,
					`rate limited until ${clock(waitUntil)}`,
					true,
				);
			}
			rateWait = RATE_WAIT_MS;
			if (status === 304) {
				return {
					status,
					headers: response.headers,
					body: null,
					etag: options.etag ?? null,
					next: null,
				};
			}
			const body: unknown = text === '' ? null : parseJson(text);
			if (status >= 400) {
				const message = field(body, 'message');
				throw new GitHubError(
					status,
					redact(
						daemon.secrets,
						`GitHub answered ${status} to ${method} ${path.split('?')[0]}${typeof message === 'string' ? `: ${message}` : ''}`,
					),
				);
			}
			return {
				status,
				headers: response.headers,
				body,
				etag: response.headers.get('etag'),
				next: nextPage(response.headers),
			};
		}
	};

	const noteRate = (headers: Headers) => {
		const limit = Number(headers.get('x-ratelimit-limit'));
		const remaining = Number(headers.get('x-ratelimit-remaining'));
		const reset = Number(headers.get('x-ratelimit-reset'));
		if (headers.has('x-ratelimit-remaining') && limit > 0) {
			rate = { limit, remaining, reset };
		}
	};

	const request = (
		method: string,
		path: string,
		options: { body?: unknown; etag?: string | null } = {},
	): Promise<GitHubResponse> => {
		const run = () => send(method, path, options);
		const result = queue.then(run, run);
		queue = result.catch(() => {});
		return result;
	};

	const pages: GitHubApi['pages'] = async (path, etag = null) => {
		const first = await request('GET', path, { etag });
		if (first.status === 304) {
			return { items: [], etag: first.etag, notModified: true };
		}
		const items: unknown[] = Array.isArray(first.body) ? [...first.body] : [];
		let { next } = first;
		for (let page = 1; next !== null && page < MAX_PAGES; page++) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const response: GitHubResponse = await request('GET', next);
			if (Array.isArray(response.body)) items.push(...response.body);
			({ next } = response);
		}
		return { items, etag: first.etag, notModified: false };
	};

	/** Your login, the `repo` scope, and write access to each configured repository. */
	const verify = async () => {
		const user = await request('GET', '/user');
		const who = field(user.body, 'login');
		login = typeof who === 'string' ? who : null;
		const problems: Array<Omit<Problem, 'since'>> = [];
		const scopes = user.headers.get('x-oauth-scopes');
		if (
			scopes !== null &&
			!scopes
				.split(',')
				.map((scope) => scope.trim())
				.includes('repo')
		) {
			problems.push({
				id: 'github-scope',
				kind: 'channel',
				text: 'Your gh login lacks the repo scope',
				fix: 'gh auth refresh -s repo',
			});
		}
		repos = 0;
		const visible: GitHubLive['repos'] = [];
		for (const repo of daemon.config.repos) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const name = await githubName(daemon, repo);
			if (name === null) continue;
			repos += 1;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop
				const found = await request('GET', `/repos/${name}`);
				visible.push({ name: repo.name, fullName: name });
				if (!canPush(found.body)) {
					problems.push({
						id: `github-push:${name}`,
						kind: 'channel',
						text: `You can't push to ${name}`,
						fix: `ask for write access to ${name}, or remove ${repo.name} from config.json`,
					});
				}
			} catch (error) {
				if (!(error instanceof GitHubError) || error.status !== 404)
					throw error;
				problems.push({
					id: `github-push:${name}`,
					kind: 'channel',
					text: `Your gh login can't see ${name}`,
					fix: `check the repository's name, or set "githubRepo" for ${repo.name} in config.json`,
				});
			}
		}
		repoProblems = problems;
		daemon.github = { ...daemon.github, repos: visible, login };
		checked = true;
		daemon.log('info', 'github connected', { login, repos });
	};

	const heartbeat = async () => {
		const response = await request('GET', '/rate_limit');
		const core = field(field(response.body, 'resources'), 'core');
		const limit = Number(field(core, 'limit'));
		const remaining = Number(field(core, 'remaining'));
		const reset = Number(field(core, 'reset'));
		if (limit > 0) rate = { limit, remaining, reset };
	};

	const tick = async () => {
		if (!daemon.config.github) {
			off(DISABLED);
			return;
		}
		if (token === null || rejected || Date.now() - readAt >= TOKEN_REREAD_MS) {
			const result = await read();
			if (!result.ok) {
				off(result.off);
				return;
			}
			if (rejected) checked = false;
		}
		try {
			if (checked) await heartbeat();
			else await verify();
			failures = 0;
			rejected = false;
			up();
			await poll({ request, pages });
			up();
		} catch (error) {
			if (!(error instanceof GitHubError)) throw error;
			if (error.status === 401) {
				rejected = true;
				checked = false;
				down(REJECTED, {
					id: 'github',
					kind: 'channel',
					text: REJECTED,
					fix: 'gh auth login',
				});
			} else if (error.rateLimited) {
				up();
			} else if (error.status === null) {
				failures += 1;
				if (failures >= OFFLINE_AFTER) {
					down(OFFLINE, {
						id: 'github',
						kind: 'channel',
						text: "Can't reach GitHub",
						fix: null,
					});
				}
			} else {
				down(error.message, {
					id: 'github',
					kind: 'channel',
					text: error.message,
					fix: null,
				});
			}
		}
	};

	// Timers don't run while the machine sleeps, so a late beat means it slept:
	// catch up at once instead of finishing the wait.
	let cutWait: (() => void) | null = null;
	let beat = Date.now();
	const watch = setInterval(() => {
		const gap = Date.now() - beat;
		beat = Date.now();
		if (gap <= 3 * TICK_MS) return;
		daemon.log('info', 'woke up', { after: duration(gap) });
		if (daemon.github.state === 'up') {
			set('connecting', 'catching up after sleep', repoProblems);
		}
		cutWait?.();
	}, TICK_MS);

	const loop = (async () => {
		let slow = 1;
		while (!stop.signal.aborted) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await tick();
			} catch (error) {
				if (stop.signal.aborted) break;
				daemon.log('warn', 'github check failed', {
					error: redact(
						daemon.secrets,
						error instanceof Error ? error.message : String(error),
					),
				});
			}
			slow =
				rate !== null && rate.remaining < SLOW_BELOW
					? Math.min(slow * 2, Math.ceil(MAX_TICK_MS / TICK_MS))
					: 1;
			const cut = new AbortController();
			cutWait = () => cut.abort();
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await sleep(
					Math.min(TICK_MS * slow, MAX_TICK_MS),
					AbortSignal.any([stop.signal, cut.signal]),
				);
			} catch {
				if (stop.signal.aborted) break;
			}
			cutWait = null;
		}
		clearInterval(watch);
	})();

	return {
		request,
		pages,
		stop: async () => {
			stop.abort();
			await loop;
			await queue;
		},
	};
}

type TokenRead = { ok: true; token: string } | { ok: false; off: string };

/**
 * `gh auth token`, with its output kept in memory. The environment drops the
 * agent's other keys but keeps GitHub tokens, so a `GH_TOKEN` that gh reads
 * still reaches it.
 */
async function readToken(
	daemon: Daemon,
	tokens: string[],
	signal: AbortSignal,
): Promise<TokenRead> {
	const gh =
		GH_OVERRIDE === undefined
			? (Bun.which('gh', { PATH: daemon.loginPath }) ?? Bun.which('gh'))
			: existsSync(GH_OVERRIDE)
				? GH_OVERRIDE
				: null;
	if (gh === null) return { ok: false, off: NOT_INSTALLED };
	let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
	try {
		child = Bun.spawn([gh, 'auth', 'token', '--hostname', 'github.com'], {
			env: envWithoutSecrets(
				daemon.secrets.filter((secret) => !tokens.includes(secret)),
			),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: GH_TIMEOUT_MS,
			signal,
		});
	} catch (error) {
		daemon.log('warn', "gh couldn't start", {
			gh,
			error: error instanceof Error ? error.message : String(error),
		});
		return { ok: false, off: NOT_INSTALLED };
	}
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const token = out.trim();
	if (code === 0 && token !== '' && !/\s/.test(token)) {
		return { ok: true, token };
	}
	const why =
		child.signalCode !== null
			? `gh auth token didn't answer within ${GH_TIMEOUT_MS / 1000} s`
			: (err.trim().split('\n')[0] ?? '');
	daemon.log('info', 'no token from gh', {
		exit: code,
		error: redact([...daemon.secrets, ...(token ? [token] : [])], why),
	});
	return { ok: false, off: NOT_LOGGED_IN };
}

/** `owner/name` of a configured repository: its `githubRepo`, or its `origin` on github.com. */
export async function githubName(
	daemon: Daemon,
	repo: Config['repos'][number],
): Promise<string | null> {
	if (repo.githubRepo !== undefined) return repo.githubRepo;
	const origin = await git(daemon, [
		'-C',
		repo.path,
		'remote',
		'get-url',
		'origin',
	]);
	return origin.code === 0 ? parseGitHubRemote(origin.stdout.trim()) : null;
}

export function parseGitHubRemote(url: string): string | null {
	const match = url.match(
		/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
	);
	return match ? `${match[1]}/${match[2]}` : null;
}

function isRateLimited(response: Response, text: string): boolean {
	if (response.status === 429) return true;
	if (response.status !== 403) return false;
	return (
		response.headers.has('retry-after') ||
		response.headers.get('x-ratelimit-remaining') === '0' ||
		/rate limit/i.test(text)
	);
}

function nextPage(headers: Headers): string | null {
	const link = headers.get('link');
	const url = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
	if (!url) return null;
	return url.startsWith(API_URL) ? url.slice(API_URL.length) : null;
}

function canPush(body: unknown): boolean {
	return field(field(body, 'permissions'), 'push') === true;
}

/** A property of a JSON value, or `null`. */
function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return null;
	}
	const record: Record<string, unknown> = { ...value };
	return record[key] ?? null;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** Followed threads: GitHub threads a task owns, once their item is fetched. */
function followedCount(daemon: Daemon): number {
	return (
		daemon.db
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM threads th JOIN github_items gi ON gi.thread_id = th.id
				WHERE th.channel = 'github' AND th.owner_task_id IS NOT NULL`,
			)
			.get()?.count ?? 0
	);
}

function duration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.round(ms / 1000)} s`;
	return minutes < 60
		? `${minutes} min`
		: `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
