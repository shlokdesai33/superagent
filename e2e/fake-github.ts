// A fake GitHub REST API for end-to-end runs: one account, a few
// repositories with issues and comments, `since` and pagination, ETags,
// rate-limit headers, and 401 for any other token.
import { createHash } from 'node:crypto';

export type FakeGitHubRequest = {
	method: string;
	path: string;
	/** The `Authorization` header as sent. */
	auth: string | null;
	body: string;
	status: number;
};

type User = { login: string; id: number; type: 'User' | 'Bot' };

type Comment = {
	id: number;
	body: string;
	user: User;
	created_at: string;
	updated_at: string;
	html_url: string;
};

type Issue = {
	repo: string;
	number: number;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: Array<{ name: string }>;
	user: User;
	closed_by: User | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	locked: boolean;
	comments: Comment[];
};

export type FakeGitHub = {
	/** For `SUPERAGENT_GITHUB_API_URL`. */
	url: string;
	requests: FakeGitHubRequest[];
	/** Accept only this token from now on. */
	setToken(token: string): void;
	openIssue(
		repo: string,
		number: number,
		issue: {
			title: string;
			body: string;
			by: string;
			labels?: string[];
		},
	): void;
	/** Adds a comment; `postedAgoMs` backdates its creation, as if posted while the agent slept. */
	comment(
		repo: string,
		number: number,
		comment: { by: string; body: string; bot?: boolean; postedAgoMs?: number },
	): number;
	closeIssue(repo: string, number: number, by: string): void;
	/** New comments on it are refused with 422, like a locked conversation. */
	lockIssue(repo: string, number: number): void;
	/** The comments on an issue, oldest first. */
	comments(repo: string, number: number): Array<{ id: number; body: string }>;
	/**
	 * Holds the next write until `release`: `arrived` resolves when it's in,
	 * and releasing it then takes effect even if the client has gone.
	 */
	holdNextWrite(): { arrived: Promise<void>; release: () => void };
	/** The next `count` writes fail with `status`. */
	failNextWrites(count: number, status: number): void;
	stop(): void;
};

const LIMIT = 5_000;

/** GitHub's timestamps: ISO 8601 to the second. */
function stamp(at: number): string {
	return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function startFakeGitHub(options: {
	login: string;
	token: string;
	/** `owner/name` → whether the account can push. */
	repos: Record<string, { push: boolean }>;
}): FakeGitHub {
	const requests: FakeGitHubRequest[] = [];
	let token = options.token;
	let remaining = LIMIT;
	const reset = Math.floor(Date.now() / 1000) + 3600;
	const issues = new Map<string, Issue>();
	let nextId = 5_000;
	const user = (login: string, bot = false): User => ({
		login,
		id: login === options.login ? 1001 : 2000 + login.length,
		type: bot ? 'Bot' : 'User',
	});
	const html = (issue: Issue) =>
		`https://github.com/${issue.repo}/issues/${issue.number}`;
	const addComment = (
		issue: Issue,
		comment: { by: string; body: string; bot?: boolean; postedAgoMs?: number },
	): Comment => {
		const now = Date.now();
		const id = ++nextId;
		const added: Comment = {
			id,
			body: comment.body,
			user: user(comment.by, comment.bot),
			created_at: stamp(now - (comment.postedAgoMs ?? 0)),
			updated_at: stamp(now),
			html_url: `${html(issue)}#issuecomment-${id}`,
		};
		issue.comments.push(added);
		issue.updated_at = stamp(now);
		return added;
	};
	const issueJson = (issue: Issue) => {
		const { repo: _, locked: __, comments, ...fields } = issue;
		return { ...fields, comments: comments.length, html_url: html(issue) };
	};
	let base = '';
	let hold: { arrived: () => void; released: Promise<void> } | null = null;
	let failing = { count: 0, status: 500 };

	const respond = (
		request: Request,
		url: URL,
		sent: string,
	): { status: number; body: unknown; headers?: Record<string, string> } => {
		const path = url.pathname;
		if (request.headers.get('authorization') !== `Bearer ${token}`) {
			return {
				status: 401,
				body: {
					message: 'Bad credentials',
					documentation_url: 'https://docs.github.com/rest',
				},
			};
		}
		if (request.method !== 'GET') {
			if (failing.count > 0) {
				failing.count -= 1;
				return { status: failing.status, body: { message: 'Server Error' } };
			}
			const target = path.match(
				/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/,
			);
			const issue = target
				? issues.get(`${target[1]}#${target[2]}`)
				: undefined;
			if (request.method !== 'POST' || !issue) {
				return { status: 404, body: { message: 'Not Found' } };
			}
			if (issue.locked) {
				return {
					status: 422,
					body: {
						message: 'Unable to create comment because issue is locked.',
					},
				};
			}
			const parsed: unknown = JSON.parse(sent || '{}');
			const body =
				typeof parsed === 'object' &&
				parsed !== null &&
				'body' in parsed &&
				typeof parsed.body === 'string'
					? parsed.body
					: '';
			return {
				status: 201,
				body: addComment(issue, { by: options.login, body }),
			};
		}
		if (path === '/rate_limit') {
			const core = { limit: LIMIT, remaining, reset, used: LIMIT - remaining };
			return { status: 200, body: { resources: { core }, rate: core } };
		}
		if (path === '/user') {
			return {
				status: 200,
				body: { login: options.login, id: 1001, type: 'User' },
				headers: { 'x-oauth-scopes': 'gist, read:org, repo, workflow' },
			};
		}
		const item = path.match(
			/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/comments)?$/,
		);
		if (item) {
			const issue = issues.get(`${item[1]}#${item[2]}`);
			if (!issue) return { status: 404, body: { message: 'Not Found' } };
			if (!item[3]) return { status: 200, body: issueJson(issue) };
			const since = url.searchParams.get('since');
			const perPage = Number(url.searchParams.get('per_page') ?? 30);
			const page = Number(url.searchParams.get('page') ?? 1);
			const matching = issue.comments.filter(
				(comment) => since === null || comment.updated_at >= since,
			);
			const shown = matching.slice((page - 1) * perPage, page * perPage);
			const next = new URL(url);
			next.searchParams.set('page', String(page + 1));
			return {
				status: 200,
				body: shown,
				headers:
					page * perPage < matching.length
						? { Link: `<${base}${next.pathname}${next.search}>; rel="next"` }
						: {},
			};
		}
		const repo = path.match(/^\/repos\/([^/]+\/[^/]+)$/)?.[1];
		const found = repo === undefined ? undefined : options.repos[repo];
		if (repo !== undefined && found !== undefined) {
			return {
				status: 200,
				body: {
					full_name: repo,
					default_branch: 'main',
					permissions: { admin: false, push: found.push, pull: true },
				},
			};
		}
		return { status: 404, body: { message: 'Not Found' } };
	};

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { pathname, search } = new URL(request.url);
			const path = `${pathname}${search}`;
			const body = await request.text();
			if (request.method !== 'GET' && hold) {
				const held = hold;
				hold = null;
				held.arrived();
				await held.released;
			}
			const answer = respond(request, new URL(request.url), body);
			const text = JSON.stringify(answer.body);
			const etag = `"${createHash('sha1').update(text).digest('hex')}"`;
			const notModified =
				answer.status === 200 && request.headers.get('if-none-match') === etag;
			if (answer.status < 300 && !notModified && pathname !== '/rate_limit') {
				remaining = Math.max(0, remaining - 1);
			}
			const status = notModified ? 304 : answer.status;
			requests.push({
				method: request.method,
				path,
				auth: request.headers.get('authorization'),
				body,
				status,
			});
			return new Response(notModified ? null : text, {
				status,
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					ETag: etag,
					'x-github-request-id': `FAKE:${requests.length}`,
					'x-ratelimit-limit': String(LIMIT),
					'x-ratelimit-remaining': String(remaining),
					'x-ratelimit-reset': String(reset),
					...answer.headers,
				},
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	return {
		url: base,
		requests,
		setToken(next) {
			token = next;
		},
		openIssue(repo, number, issue) {
			const now = stamp(Date.now());
			issues.set(`${repo}#${number}`, {
				repo,
				number,
				title: issue.title,
				body: issue.body,
				state: 'open',
				labels: (issue.labels ?? []).map((name) => ({ name })),
				user: user(issue.by),
				closed_by: null,
				created_at: now,
				updated_at: now,
				closed_at: null,
				locked: false,
				comments: [],
			});
		},
		comment(repo, number, comment) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue) throw new Error(`no issue ${repo}#${number}`);
			return addComment(issue, comment).id;
		},
		lockIssue(repo, number) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue) throw new Error(`no issue ${repo}#${number}`);
			issue.locked = true;
		},
		comments(repo, number) {
			return (issues.get(`${repo}#${number}`)?.comments ?? []).map(
				(comment) => ({ id: comment.id, body: comment.body }),
			);
		},
		holdNextWrite() {
			const arrival = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			hold = { arrived: arrival.resolve, released: release.promise };
			return { arrived: arrival.promise, release: release.resolve };
		},
		failNextWrites(count, status) {
			failing = { count, status };
		},
		closeIssue(repo, number, by) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue) throw new Error(`no issue ${repo}#${number}`);
			const now = stamp(Date.now());
			issue.state = 'closed';
			issue.closed_by = user(by);
			issue.closed_at = now;
			issue.updated_at = now;
		},
		stop: () => {
			void server.stop(true);
		},
	};
}
