// A fake GitHub REST API for end-to-end runs: one account, a few
// repositories with issues, PRs, comments, review comments and reviews,
// `since` and pagination, ETags, rate-limit headers, and 401 for any other
// token.
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

type ReviewComment = Comment & {
	path: string;
	line: number;
	diff_hunk: string;
	in_reply_to_id?: number;
};

type Review = {
	id: number;
	user: User;
	body: string;
	state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
	submitted_at: string;
	html_url: string;
};

type Pr = {
	head: string;
	base: string;
	sha: string;
	merged_at: string | null;
	merged_by: User | null;
	reviewComments: ReviewComment[];
	reviews: Review[];
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
	pr: Pr | null;
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
	/** The next read of a path starting with `prefix` fails with `status`. */
	failNextRead(prefix: string, status: number): void;
	/** What `gh pr create` would do: a PR from `head` into `base`. */
	openPr(
		repo: string,
		number: number,
		pr: {
			title: string;
			body: string;
			by: string;
			head: string;
			base?: string;
		},
	): void;
	/** The PR's body as it is now. */
	prBody(repo: string, number: number): string;
	reviewComment(
		repo: string,
		number: number,
		comment: {
			by: string;
			body: string;
			path: string;
			line: number;
			bot?: boolean;
		},
	): number;
	/** The review comments on a PR, oldest first. */
	reviewComments(
		repo: string,
		number: number,
	): Array<{ id: number; body: string; inReplyTo: number | null }>;
	review(
		repo: string,
		number: number,
		review: {
			by: string;
			state: Review['state'];
			body?: string;
			bot?: boolean;
		},
	): void;
	merge(repo: string, number: number, by: string): void;
	/** The PR's head commit. */
	prHead(repo: string, number: number): string;
	/** What a push to the PR's branch does: a new head commit. */
	pushCommit(repo: string, number: number, sha: string): void;
	/** Replaces a commit's check runs and commit statuses. */
	setChecks(
		repo: string,
		sha: string,
		checks: {
			runs: Array<{ name: string; status: string; conclusion?: string }>;
			statuses?: Array<{ context: string; state: string }>;
		},
	): void;
	stop(): void;
};

const LIMIT = 5_000;

/** The `body` field of a JSON request. */
function bodyOf(sent: string): string {
	const parsed: unknown = JSON.parse(sent || '{}');
	return typeof parsed === 'object' &&
		parsed !== null &&
		'body' in parsed &&
		typeof parsed.body === 'string'
		? parsed.body
		: '';
}

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
	const checks = new Map<
		string,
		{
			runs: Array<{
				id: number;
				name: string;
				status: string;
				conclusion: string | null;
				html_url: string;
			}>;
			statuses: Array<{ context: string; state: string; target_url: string }>;
		}
	>();
	let nextId = 5_000;
	const user = (login: string, bot = false): User => ({
		login,
		id: login === options.login ? 1001 : 2000 + login.length,
		type: bot ? 'Bot' : 'User',
	});
	const html = (issue: Issue) =>
		`https://github.com/${issue.repo}/${issue.pr ? 'pull' : 'issues'}/${issue.number}`;
	const issueAt = (repo: string | undefined, number: string | undefined) =>
		repo && number ? issues.get(`${repo}#${number}`) : undefined;
	/** A page of `items` updated since `since`, with a `Link` to the next. */
	const listing = (
		url: URL,
		items: Array<{ updated_at: string }>,
	): { status: number; body: unknown; headers: Record<string, string> } => {
		const since = url.searchParams.get('since');
		const perPage = Number(url.searchParams.get('per_page') ?? 30);
		const page = Number(url.searchParams.get('page') ?? 1);
		const matching = items.filter(
			(item) => since === null || item.updated_at >= since,
		);
		const next = new URL(url);
		next.searchParams.set('page', String(page + 1));
		return {
			status: 200,
			body: matching.slice((page - 1) * perPage, page * perPage),
			headers:
				page * perPage < matching.length
					? { Link: `<${base}${next.pathname}${next.search}>; rel="next"` }
					: {},
		};
	};
	/** A page of `items`, oldest first and unfiltered, like GitHub's reviews. */
	const paged = (
		url: URL,
		items: unknown[],
	): { status: number; body: unknown; headers: Record<string, string> } => {
		const perPage = Number(url.searchParams.get('per_page') ?? 30);
		const page = Number(url.searchParams.get('page') ?? 1);
		const next = new URL(url);
		next.searchParams.set('page', String(page + 1));
		return {
			status: 200,
			body: items.slice((page - 1) * perPage, page * perPage),
			headers:
				page * perPage < items.length
					? { Link: `<${base}${next.pathname}${next.search}>; rel="next"` }
					: {},
		};
	};
	const prJson = (issue: Issue, pr: Pr) => ({
		number: issue.number,
		title: issue.title,
		body: issue.body,
		state: issue.state,
		draft: false,
		merged: pr.merged_at !== null,
		merged_at: pr.merged_at,
		merged_by: pr.merged_by,
		mergeable: true,
		user: issue.user,
		head: { ref: pr.head, sha: pr.sha },
		base: { ref: pr.base },
		html_url: html(issue),
		created_at: issue.created_at,
		updated_at: issue.updated_at,
		closed_at: issue.closed_at,
	});
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
	const addReviewComment = (
		issue: Issue,
		pr: Pr,
		comment: {
			by: string;
			body: string;
			path: string;
			line: number;
			bot?: boolean;
			inReplyTo?: number;
		},
	): ReviewComment => {
		const now = stamp(Date.now());
		const id = ++nextId;
		const added: ReviewComment = {
			id,
			body: comment.body,
			user: user(comment.by, comment.bot),
			created_at: now,
			updated_at: now,
			html_url: `${html(issue)}#discussion_r${id}`,
			path: comment.path,
			line: comment.line,
			diff_hunk: `@@ -1,3 +1,3 @@\n context\n-old line\n+new line ${comment.line}`,
			...(comment.inReplyTo ? { in_reply_to_id: comment.inReplyTo } : {}),
		};
		pr.reviewComments.push(added);
		issue.updated_at = now;
		return added;
	};
	const issueJson = (issue: Issue) => {
		const { repo: _, locked: __, comments, pr, ...fields } = issue;
		return {
			...fields,
			comments: comments.length,
			html_url: html(issue),
			...(pr ? { pull_request: { merged_at: pr.merged_at } } : {}),
		};
	};
	let base = '';
	let hold: { arrived: () => void; released: Promise<void> } | null = null;
	let failing = { count: 0, status: 500 };
	const failingReads: Array<{ prefix: string; status: number }> = [];

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
		const failRead = failingReads.findIndex((entry) =>
			path.startsWith(entry.prefix),
		);
		if (request.method === 'GET' && failRead !== -1) {
			const [entry] = failingReads.splice(failRead, 1);
			return { status: entry?.status ?? 500, body: { message: 'Failed' } };
		}
		if (request.method !== 'GET') {
			if (failing.count > 0) {
				failing.count -= 1;
				return { status: failing.status, body: { message: 'Server Error' } };
			}
			const edit = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
			const edited = issueAt(edit?.[1], edit?.[2]);
			if (request.method === 'PATCH' && edited?.pr) {
				edited.body = bodyOf(sent);
				edited.updated_at = stamp(Date.now());
				return { status: 200, body: prJson(edited, edited.pr) };
			}
			const reply = path.match(
				/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/,
			);
			const replied = issueAt(reply?.[1], reply?.[2]);
			const parent = replied?.pr?.reviewComments.find(
				(comment) => comment.id === Number(reply?.[3]),
			);
			if (request.method === 'POST' && replied?.pr && parent) {
				return {
					status: 201,
					body: addReviewComment(replied, replied.pr, {
						by: options.login,
						body: bodyOf(sent),
						path: parent.path,
						line: parent.line,
						inReplyTo: parent.id,
					}),
				};
			}
			const target = path.match(
				/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/,
			);
			const issue = issueAt(target?.[1], target?.[2]);
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
			return {
				status: 201,
				body: addComment(issue, { by: options.login, body: bodyOf(sent) }),
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
			const issue = issueAt(item[1], item[2]);
			if (!issue) return { status: 404, body: { message: 'Not Found' } };
			if (!item[3]) return { status: 200, body: issueJson(issue) };
			return listing(url, issue.comments);
		}
		const pulls = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
		if (pulls?.[1]) {
			const repo = pulls[1];
			const head = url.searchParams.get('head');
			const state = url.searchParams.get('state') ?? 'open';
			const owner = repo.split('/')[0];
			return {
				status: 200,
				body: [...issues.values()]
					.filter(
						(issue) =>
							issue.repo === repo &&
							issue.pr !== null &&
							(head === null || head === `${owner}:${issue.pr.head}`) &&
							(state === 'all' || issue.state === state),
					)
					.toSorted((a, b) => b.number - a.number)
					.map((issue) => (issue.pr ? prJson(issue, issue.pr) : null)),
			};
		}
		const pull = path.match(
			/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/comments|\/reviews)?$/,
		);
		if (pull) {
			const issue = issueAt(pull[1], pull[2]);
			if (!issue?.pr) return { status: 404, body: { message: 'Not Found' } };
			if (!pull[3]) return { status: 200, body: prJson(issue, issue.pr) };
			if (pull[3] === '/comments') return listing(url, issue.pr.reviewComments);
			return paged(url, issue.pr.reviews);
		}
		const commit = path.match(
			/^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/(check-runs|status)$/,
		);
		if (commit) {
			const onCommit = checks.get(`${commit[1]}@${commit[2]}`) ?? {
				runs: [],
				statuses: [],
			};
			if (commit[3] === 'check-runs') {
				const perPage = Number(url.searchParams.get('per_page') ?? 30);
				const page = Number(url.searchParams.get('page') ?? 1);
				return {
					status: 200,
					body: {
						total_count: onCommit.runs.length,
						check_runs: onCommit.runs.slice(
							(page - 1) * perPage,
							page * perPage,
						),
					},
				};
			}
			const states = onCommit.statuses.map((entry) => entry.state);
			// Like GitHub: the state covers every status; the list is paged.
			const perPage = Number(url.searchParams.get('per_page') ?? 30);
			const page = Number(url.searchParams.get('page') ?? 1);
			return {
				status: 200,
				body: {
					sha: commit[2],
					total_count: onCommit.statuses.length,
					statuses: onCommit.statuses.slice(
						(page - 1) * perPage,
						page * perPage,
					),
					state:
						states.length === 0 || states.includes('pending')
							? 'pending'
							: states.some((state) => state === 'failure' || state === 'error')
								? 'failure'
								: 'success',
				},
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
				pr: null,
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
		failNextRead(prefix, status) {
			failingReads.push({ prefix, status });
		},
		openPr(repo, number, pr) {
			const now = stamp(Date.now());
			issues.set(`${repo}#${number}`, {
				repo,
				number,
				title: pr.title,
				body: pr.body,
				state: 'open',
				labels: [],
				user: user(pr.by),
				closed_by: null,
				created_at: now,
				updated_at: now,
				closed_at: null,
				locked: false,
				comments: [],
				pr: {
					head: pr.head,
					base: pr.base ?? 'main',
					sha: createHash('sha1').update(`${repo}#${number}`).digest('hex'),
					merged_at: null,
					merged_by: null,
					reviewComments: [],
					reviews: [],
				},
			});
		},
		prBody(repo, number) {
			return issues.get(`${repo}#${number}`)?.body ?? '';
		},
		reviewComment(repo, number, comment) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue?.pr) throw new Error(`no PR ${repo}#${number}`);
			return addReviewComment(issue, issue.pr, comment).id;
		},
		reviewComments(repo, number) {
			return (issues.get(`${repo}#${number}`)?.pr?.reviewComments ?? []).map(
				(comment) => ({
					id: comment.id,
					body: comment.body,
					inReplyTo: comment.in_reply_to_id ?? null,
				}),
			);
		},
		review(repo, number, review) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue?.pr) throw new Error(`no PR ${repo}#${number}`);
			const id = ++nextId;
			issue.pr.reviews.push({
				id,
				user: user(review.by, review.bot),
				body: review.body ?? '',
				state: review.state,
				submitted_at: stamp(Date.now()),
				html_url: `${html(issue)}#pullrequestreview-${id}`,
			});
			issue.updated_at = stamp(Date.now());
		},
		prHead(repo, number) {
			return issues.get(`${repo}#${number}`)?.pr?.sha ?? '';
		},
		pushCommit(repo, number, sha) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue?.pr) throw new Error(`no PR ${repo}#${number}`);
			issue.pr.sha = sha;
			issue.updated_at = stamp(Date.now());
		},
		setChecks(repo, sha, set) {
			checks.set(`${repo}@${sha}`, {
				runs: set.runs.map((run) => ({
					id: ++nextId,
					name: run.name,
					status: run.status,
					conclusion: run.conclusion ?? null,
					html_url: `https://github.com/${repo}/runs/${nextId}`,
				})),
				statuses: (set.statuses ?? []).map((entry) => ({
					context: entry.context,
					state: entry.state,
					target_url: `https://ci.example.com/${sha}/${entry.context}`,
				})),
			});
		},
		merge(repo, number, by) {
			const issue = issues.get(`${repo}#${number}`);
			if (!issue?.pr) throw new Error(`no PR ${repo}#${number}`);
			const now = stamp(Date.now());
			issue.state = 'closed';
			issue.closed_at = now;
			issue.updated_at = now;
			issue.pr.merged_at = now;
			issue.pr.merged_by = user(by);
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
