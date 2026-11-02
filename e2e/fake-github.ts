// A fake GitHub REST API for end-to-end runs: one account, a few
// repositories, ETags, rate-limit headers, and 401 for any other token.
import { createHash } from 'node:crypto';

export type FakeGitHubRequest = {
	method: string;
	path: string;
	/** The `Authorization` header as sent. */
	auth: string | null;
	body: string;
	status: number;
};

export type FakeGitHub = {
	/** For `SUPERAGENT_GITHUB_API_URL`. */
	url: string;
	requests: FakeGitHubRequest[];
	/** Accept only this token from now on. */
	setToken(token: string): void;
	stop(): void;
};

const LIMIT = 5_000;

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

	const respond = (
		request: Request,
		path: string,
	): { status: number; body: unknown; headers?: Record<string, string> } => {
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
			return { status: 404, body: { message: 'Not Found' } };
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
			const answer = respond(request, pathname);
			const text = JSON.stringify(answer.body);
			const etag = `"${createHash('sha1').update(text).digest('hex')}"`;
			const notModified =
				answer.status === 200 && request.headers.get('if-none-match') === etag;
			if (answer.status === 200 && !notModified && pathname !== '/rate_limit') {
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
	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		setToken(next) {
			token = next;
		},
		stop: () => {
			void server.stop(true);
		},
	};
}
