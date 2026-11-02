import type { Database } from 'bun:sqlite';
import {
	type GitHubApi,
	GitHubError,
	type GitHubResponse,
	githubOff,
} from './github.ts';
import { ingest } from './ingest.ts';
import { redact } from './secrets.ts';
import { type Daemon, type Params, cut } from './state.ts';
import { publishTask } from './task-feed.ts';

const THREAD_ID = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
/** Ends every comment the agent posts; it's how its own comments are recognized. */
export const MARKER = '<!-- superagent ';
const MAX_FOLLOWED = 20;
const INTRO_COMMENTS = 10;
const INTRO_CHARS = 2_000;
const PER_PAGE = 100;
const REVIEW_PAGES = 10;

export function parseGitHubThread(
	id: string,
): { repo: string; number: number } | null {
	const match = id.match(THREAD_ID);
	return match?.[1] && match[2]
		? { repo: match[1], number: Number(match[2]) }
		: null;
}

/**
 * Makes a `github:owner/name#42` thread usable by a task: on a configured
 * repository, with its row created if it's new. Synchronous, so it runs
 * inside the Router tool's transaction. Returns the thread's ID as stored.
 */
export function prepareGitHubThread(
	daemon: Daemon,
	id: string,
): { ok: true; id: string } | { ok: false; error: string } {
	const off = githubOff(daemon);
	if (off !== null) return { ok: false, error: off };
	const parsed = parseGitHubThread(id);
	if (parsed === null) {
		return {
			ok: false,
			error: `${JSON.stringify(id)} isn't a GitHub thread; use github:owner/name#42`,
		};
	}
	const { repos } = daemon.github;
	const repo = repos.find(
		(entry) => entry.fullName.toLowerCase() === parsed.repo.toLowerCase(),
	);
	if (!repo) {
		return {
			ok: false,
			error:
				repos.length === 0
					? daemon.github.state === 'connecting'
						? 'GitHub is still connecting; try again in a minute'
						: 'no configured repository is on GitHub'
					: `${parsed.repo} isn't a configured repository; use one of ${repos.map((entry) => entry.fullName).join(', ')}`,
		};
	}
	return {
		ok: true,
		id: ensureThread(
			daemon,
			repo,
			parsed.number,
			`https://github.com/${repo.fullName}/issues/${parsed.number}`,
		),
	};
}

/** The thread of an issue or PR on a configured repository, created when new. */
function ensureThread(
	daemon: Daemon,
	repo: { name: string; fullName: string },
	number: number,
	url: string,
): string {
	const id = `github:${repo.fullName}#${number}`;
	daemon.db
		.query<unknown, Params>(
			`INSERT OR IGNORE INTO threads (id, channel, title, url, ownable, created_at)
			VALUES ($id, 'github', $title, $url, 1, $at)`,
		)
		.run({
			id,
			title: `${daemon.github.repos.length > 1 ? repo.name : ''}#${number}`,
			url,
			at: Date.now(),
		});
	return id;
}

/** The visible sign-off and the hidden marker that end everything the agent posts. */
export function signOff(
	daemon: Daemon,
	handle: string | null,
	marker: string,
): string {
	const { login: who } = daemon.github;
	return `<sub>Posted by superagent${who ? ` for @${who}` : ''}${handle ? ` · task ${handle}` : ''}</sub>\n${MARKER}${marker} -->`;
}

/** The configured repository all these GitHub threads are on, if there's exactly one. */
export function repoOfThreads(daemon: Daemon, ids: string[]): string | null {
	const names = new Set(
		ids
			.map((id) => parseGitHubThread(id)?.repo.toLowerCase())
			.filter((repo) => repo !== undefined)
			.map(
				(repo) =>
					daemon.github.repos.find(
						(entry) => entry.fullName.toLowerCase() === repo,
					)?.name,
			),
	);
	const [only] = names;
	return names.size === 1 && only !== undefined ? only : null;
}

type ItemRow = {
	id: string;
	title: string;
	url: string | null;
	repo: string;
	number: number;
	isPr: number;
	state: string;
	itemTitle: string;
};

/**
 * For each GitHub thread the task owns that hasn't been fetched yet: the
 * issue and its last comments, for the Worker's next message. Their comment
 * cursor starts here, so these comments don't come again as events. `null`
 * when there's nothing new.
 */
export async function githubIntros(
	daemon: Daemon,
	taskId: number,
): Promise<string | null> {
	const { db } = daemon;
	const threads = db
		.query<{ id: string }, [number]>(
			`SELECT th.id FROM threads th LEFT JOIN github_items gi ON gi.thread_id = th.id
			WHERE th.owner_task_id = ? AND th.channel = 'github' AND gi.thread_id IS NULL
			ORDER BY th.created_at`,
		)
		.all(taskId);
	if (threads.length === 0) return null;
	const api = daemon.githubApi;
	const parts: string[] = [];
	for (const { id } of threads) {
		const parsed = parseGitHubThread(id);
		if (parsed === null) continue;
		if (api === null || daemon.github.state !== 'up') {
			parts.push(
				`You follow ${id}, but GitHub is ${daemon.github.state} (${daemon.github.detail ?? ''}), so it couldn't be fetched yet. It's tried again before your next step.`,
			);
			continue;
		}
		const path = `/repos/${parsed.repo}/issues/${parsed.number}`;
		let issue: unknown;
		let comments: unknown[];
		let reviewComments: unknown[] = [];
		let reviews: unknown[] = [];
		let etag: string | null;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const response = await api.request('GET', path);
			issue = response.body;
			({ etag } = response);
			// oxlint-disable-next-line eslint/no-await-in-loop
			comments = (await api.pages(`${path}/comments?per_page=100`)).items;
			if (field(issue, 'pull_request') !== null) {
				const pull = `/repos/${parsed.repo}/pulls/${parsed.number}`;
				// oxlint-disable-next-line eslint/no-await-in-loop
				reviewComments = (await api.pages(`${pull}/comments?per_page=100`))
					.items;
				// oxlint-disable-next-line eslint/no-await-in-loop
				reviews = (await api.pages(`${pull}/reviews?per_page=100`)).items;
			}
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) {
				db.query<unknown, [string, number]>(
					'UPDATE threads SET owner_task_id = NULL WHERE id = ? AND owner_task_id = ?',
				).run(id, taskId);
				parts.push(
					`${parsed.repo}#${parsed.number} doesn't exist on GitHub, or your gh login can't see it, so you no longer follow ${id}.`,
				);
				continue;
			}
			parts.push(
				`You follow ${id}, but it couldn't be fetched (${error instanceof Error ? error.message : String(error)}). It's tried again before your next step.`,
			);
			continue;
		}
		const at = Date.now();
		const title = text(issue, 'title');
		const isPr = field(issue, 'pull_request') !== null;
		const created = text(issue, 'created_at');
		const newestOf = (items: unknown[]) =>
			items.reduce<string>((latest, item) => {
				const updated = text(item, 'updated_at');
				return updated > latest ? updated : latest;
			}, created);
		db.transaction(() => {
			db.query<unknown, Params>(
				`INSERT INTO github_items (thread_id, repo, number, is_pr, title, state, polled_at, updated_at)
				VALUES ($id, $repo, $number, $isPr, $title, $state, $at, $updated)`,
			).run({
				id,
				repo: parsed.repo,
				number: parsed.number,
				isPr: isPr ? 1 : 0,
				title,
				state: itemState(issue),
				at,
				updated: text(issue, 'updated_at'),
			});
			// A PR's state comes from /pulls, whose ETag differs.
			saveCursor(db, `${id}:item`, null, isPr ? null : etag);
			saveCursor(db, `${id}:comments`, newestOf(comments), null);
			if (isPr) {
				saveCursor(db, `${id}:review-comments`, newestOf(reviewComments), null);
				// Reviews have no `since`: polling reads from the last page on.
				saveCursor(
					db,
					`${id}:reviews`,
					created,
					null,
					Math.floor(reviews.length / PER_PAGE) + 1,
				);
			}
			// Already in the Worker's message: recorded so polling skips them.
			const seen: Array<[string, unknown]> = [
				...comments.map((item): [string, unknown] => ['issue-comment', item]),
				...reviewComments.map((item): [string, unknown] => [
					'review-comment',
					item,
				]),
				...reviews.map((item): [string, unknown] => ['review', item]),
			];
			for (const [prefix, item] of seen) {
				db.query<unknown, Params>(
					`INSERT OR IGNORE INTO events (received_at, channel, external_id, thread_id, kind, author,
						text, route, filter_reason, consumed_at)
					VALUES ($at, 'github', $externalId, $thread, 'message', $author, $text, 'filtered',
						'shown when the task took the thread', $at)`,
				).run({
					at,
					externalId: `${prefix}:${idOf(field(item, 'id')) ?? '?'}`,
					thread: id,
					author: login(item),
					text: redact(daemon.secrets, text(item, 'body')),
				});
			}
		})();
		parts.push(
			introText(daemon, id, parsed, issue, comments, reviewComments, reviews),
		);
	}
	return parts.length > 0 ? parts.join('\n\n') : null;
}

function introText(
	daemon: Daemon,
	id: string,
	parsed: { repo: string; number: number },
	issue: unknown,
	comments: unknown[],
	reviewComments: unknown[],
	reviews: unknown[],
): string {
	const labels = field(issue, 'labels');
	const labelNames = Array.isArray(labels)
		? labels.map((label) => text(label, 'name')).filter(Boolean)
		: [];
	const shown = comments.slice(-INTRO_COMMENTS);
	const kind = field(issue, 'pull_request') === null ? 'issue' : 'PR';
	const lines = [
		`GitHub ${kind} ${parsed.repo}#${parsed.number} (thread ${id}): ${text(issue, 'title')}`,
		[
			itemState(issue),
			labelNames.length > 0 ? `labels: ${labelNames.join(', ')}` : null,
			`opened by ${login(issue)}`,
			text(issue, 'html_url'),
		]
			.filter(Boolean)
			.join(' · '),
		'',
		clip(daemon, text(issue, 'body')) || '(no description)',
	];
	if (shown.length > 0) {
		lines.push(
			'',
			comments.length > shown.length
				? `The last ${shown.length} of ${comments.length} comments:`
				: `Comments (${shown.length}):`,
		);
		for (const comment of shown) {
			lines.push(
				`${login(comment)}${isBot(comment) ? ' (bot)' : ''} · ${text(comment, 'created_at')}:`,
				clip(daemon, text(comment, 'body'))
					.split('\n')
					.map((line) => `  ${line}`)
					.join('\n'),
			);
		}
	}
	const shownReviewComments = reviewComments.slice(-INTRO_COMMENTS);
	if (shownReviewComments.length > 0) {
		lines.push(
			'',
			reviewComments.length > shownReviewComments.length
				? `The last ${shownReviewComments.length} of ${reviewComments.length} review comments:`
				: `Review comments (${shownReviewComments.length}):`,
		);
		for (const comment of shownReviewComments) {
			const line = field(comment, 'line') ?? field(comment, 'original_line');
			lines.push(
				`${login(comment)}${isBot(comment) ? ' (bot)' : ''} · ${text(comment, 'path')}${typeof line === 'number' ? `:${line}` : ''}:`,
				clip(daemon, text(comment, 'body'))
					.split('\n')
					.map((part) => `  ${part}`)
					.join('\n'),
			);
		}
	}
	const shownReviews = reviews
		.filter(
			(review) =>
				text(review, 'body') !== '' ||
				(text(review, 'state') !== 'COMMENTED' &&
					REVIEW_WORDS[text(review, 'state')] !== undefined),
		)
		.slice(-INTRO_COMMENTS);
	if (shownReviews.length > 0) {
		lines.push('', `Reviews (the last ${shownReviews.length}):`);
		for (const review of shownReviews) {
			const body = clip(daemon, text(review, 'body'));
			lines.push(
				`${login(review)}${isBot(review) ? ' (bot)' : ''} · ${REVIEW_WORDS[text(review, 'state')] ?? text(review, 'state').toLowerCase()}${body ? ':' : ''}`,
				...(body
					? [
							body
								.split('\n')
								.map((part) => `  ${part}`)
								.join('\n'),
						]
					: []),
			);
		}
	}
	lines.push('', 'New comments and changes on it come to you.');
	return lines.join('\n');
}

/**
 * One round of polling: PRs opened from tasks' branches, then for each
 * followed thread its state, comments and, for PRs, review comments and
 * reviews, as events for the owning task.
 */
export async function pollFollowed(
	daemon: Daemon,
	api: GitHubApi,
): Promise<void> {
	await findTaskPrs(daemon, api);
	const rows = daemon.db
		.query<ItemRow, [number]>(
			`SELECT th.id, th.title, th.url, gi.repo, gi.number, gi.is_pr AS isPr, gi.state,
				gi.title AS itemTitle
			FROM threads th JOIN github_items gi ON gi.thread_id = th.id
			WHERE th.channel = 'github' AND th.owner_task_id IS NOT NULL
			ORDER BY COALESCE(th.last_event_at, th.created_at) DESC LIMIT ?`,
		)
		.all(MAX_FOLLOWED);
	for (const row of rows) {
		try {
			if (row.isPr === 1) {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollPr(daemon, api, row);
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollComments(daemon, api, row, 'issue');
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollComments(daemon, api, row, 'review');
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollReviews(daemon, api, row);
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollCi(daemon, api, row);
			} else {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollItem(daemon, api, row);
				// oxlint-disable-next-line eslint/no-await-in-loop
				await pollComments(daemon, api, row, 'issue');
			}
		} catch (error) {
			if (!(error instanceof GitHubError) || error.status !== 404) {
				throw error;
			}
			daemon.log('warn', 'followed GitHub item not found', {
				thread: row.id,
			});
		}
		daemon.db
			.query<unknown, [number, string]>(
				'UPDATE github_items SET polled_at = ? WHERE thread_id = ?',
			)
			.run(Date.now(), row.id);
	}
}

async function pollItem(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const key = `${row.id}:item`;
	const cursor = loadCursor(daemon.db, key);
	const response = await api.request(
		'GET',
		`/repos/${row.repo}/issues/${row.number}`,
		{ etag: cursor?.etag ?? null },
	);
	if (response.status === 304) return;
	const issue = response.body;
	const state = itemState(issue);
	const updated = text(issue, 'updated_at');
	if (state !== row.state) {
		const name = `#${row.number}`;
		const change =
			state === 'merged'
				? {
						externalId: `merged:${row.repo}#${row.number}`,
						author: 'GitHub',
						text: `${name} was merged`,
					}
				: state === 'closed'
					? {
							externalId: `closed:${row.repo}#${row.number}:${text(issue, 'closed_at')}`,
							author: login(field(issue, 'closed_by')) || 'GitHub',
							text: `${name} was closed by ${login(field(issue, 'closed_by')) || 'someone'}`,
						}
					: {
							externalId: `reopened:${row.repo}#${row.number}:${updated}`,
							author: 'GitHub',
							text: `${name} was reopened`,
						};
		ingest(daemon, {
			channel: 'github',
			externalId: change.externalId,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'activity',
			author: { name: change.author, id: null, isBot: false, isSelf: false },
			text: change.text,
			mentionsAgent: false,
			data: eventData(row, text(issue, 'html_url'), Date.parse(updated)),
		});
	}
	daemon.db
		.query<unknown, Params>(
			`UPDATE github_items SET state = $state, title = $title, updated_at = $updated
			WHERE thread_id = $id`,
		)
		.run({ id: row.id, state, title: text(issue, 'title'), updated });
	saveCursor(daemon.db, key, null, response.etag);
}

/** New conversation comments, or a PR's review comments on lines of its diff. */
async function pollComments(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
	kind: 'issue' | 'review',
): Promise<void> {
	const key = `${row.id}:${kind === 'issue' ? 'comments' : 'review-comments'}`;
	const cursor = loadCursor(daemon.db, key);
	const since = cursor?.since ?? new Date().toISOString();
	const listing =
		kind === 'issue'
			? `/repos/${row.repo}/issues/${row.number}/comments`
			: `/repos/${row.repo}/pulls/${row.number}/comments`;
	const { items, etag, notModified } = await api.pages(
		`${listing}?since=${encodeURIComponent(since)}&per_page=100`,
		cursor?.etag ?? null,
	);
	if (notModified) return;
	let newest = since;
	const comments = items.toSorted(
		(a, b) =>
			text(a, 'updated_at').localeCompare(text(b, 'updated_at')) ||
			Number(field(a, 'id')) - Number(field(b, 'id')),
	);
	for (const comment of comments) {
		const updated = text(comment, 'updated_at');
		if (updated > newest) newest = updated;
		const body = redact(daemon.secrets, text(comment, 'body'));
		const userId = idOf(field(field(comment, 'user'), 'id'));
		const commentId = idOf(field(comment, 'id')) ?? '?';
		const line = field(comment, 'line') ?? field(comment, 'original_line');
		const where = `${text(comment, 'path')}${typeof line === 'number' ? `:${line}` : ''}`;
		ingest(daemon, {
			channel: 'github',
			externalId: `${kind === 'issue' ? 'issue-comment' : 'review-comment'}:${commentId}`,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'message',
			author: {
				name: login(comment) || 'someone',
				id: userId,
				isBot: isBot(comment),
				isSelf: body.includes(MARKER),
			},
			text:
				kind === 'issue'
					? body || '(empty comment)'
					: `${where}: ${body || '(empty comment)'}`,
			mentionsAgent: false,
			data: {
				...eventData(
					row,
					text(comment, 'html_url'),
					Date.parse(text(comment, 'created_at')),
				),
				...(kind === 'issue'
					? { comment: field(comment, 'id') }
					: {
							reviewComment: field(comment, 'id'),
							path: text(comment, 'path'),
							line: typeof line === 'number' ? line : null,
							diffHunk: text(comment, 'diff_hunk')
								.split('\n')
								.slice(-3)
								.join('\n'),
						}),
			},
		});
	}
	// A new `since` is a new URL, whose ETag isn't known yet.
	saveCursor(daemon.db, key, newest, newest === since ? etag : null);
}

/** A followed PR's state: merged, closed or reopened become events; the rest is for `read_thread`. */
async function pollPr(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const key = `${row.id}:item`;
	const cursor = loadCursor(daemon.db, key);
	const response = await api.request(
		'GET',
		`/repos/${row.repo}/pulls/${row.number}`,
		{ etag: cursor?.etag ?? null },
	);
	if (response.status === 304) return;
	const pr = response.body;
	const state =
		field(pr, 'merged') === true || field(pr, 'merged_at') !== null
			? 'merged'
			: text(pr, 'state') === 'closed'
				? 'closed'
				: 'open';
	const updated = text(pr, 'updated_at');
	if (state !== row.state) {
		const name = `#${row.number}`;
		const mergedBy = login(field(pr, 'merged_by'));
		const change =
			state === 'merged'
				? {
						externalId: `merged:${row.repo}#${row.number}`,
						author: mergedBy || 'GitHub',
						text: `${name} was merged${mergedBy ? ` by ${mergedBy}` : ''}`,
					}
				: state === 'closed'
					? {
							externalId: `closed:${row.repo}#${row.number}:${text(pr, 'closed_at')}`,
							author: 'GitHub',
							text: `${name} was closed without merging`,
						}
					: {
							externalId: `reopened:${row.repo}#${row.number}:${updated}`,
							author: 'GitHub',
							text: `${name} was reopened`,
						};
		ingest(daemon, {
			channel: 'github',
			externalId: change.externalId,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'activity',
			author: { name: change.author, id: null, isBot: false, isSelf: false },
			text: change.text,
			mentionsAgent: false,
			data: eventData(row, text(pr, 'html_url'), Date.parse(updated)),
		});
	}
	const summary = summaryOf(daemon.db, row.id);
	summary.mergeable = field(pr, 'mergeable');
	summary.draft = field(pr, 'draft') === true;
	daemon.db
		.query<unknown, Params>(
			`UPDATE github_items SET state = $state, title = $title, head_sha = $head,
				summary = $summary, updated_at = $updated
			WHERE thread_id = $id`,
		)
		.run({
			id: row.id,
			state,
			title: text(pr, 'title'),
			head: text(field(pr, 'head'), 'sha') || null,
			summary: JSON.stringify(summary),
			updated,
		});
	saveCursor(daemon.db, key, null, response.etag);
}

const CI_FAILED = new Set([
	'failure',
	'timed_out',
	'cancelled',
	'action_required',
	'startup_failure',
]);
const CI_PASSED = new Set(['success', 'neutral', 'skipped']);

type CiRun = {
	id: string | null;
	name: string;
	status: string;
	conclusion: string;
	url: string;
};
type CiStatus = { context: string; state: string; url: string };
type Ci = {
	sha: string;
	runs: CiRun[];
	statuses: CiStatus[];
	/** Every commit status, listed or not. */
	statusTotal: number;
	combined: string;
	outcome: 'pending' | 'failure' | 'success' | null;
	failing: string[];
	/** The last outcome sent to the task, and for which commit. */
	sent: { sha: string; outcome: string; key: string } | null;
};

/**
 * The checks on a followed PR's head commit: its check runs and commit
 * statuses, combined into one outcome. A `ci` event goes to the task when
 * a commit's outcome turns failure or success and differs from the last
 * one sent for it; a PR with no checks sends none.
 */
async function pollCi(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const { db } = daemon;
	const head = db
		.query<{ head: string | null }, [string]>(
			'SELECT head_sha AS head FROM github_items WHERE thread_id = ?',
		)
		.get(row.id)?.head;
	if (!head) return;
	const summary = summaryOf(db, row.id);
	const known = field(summary, 'ci');
	const previous = isCi(known) && known.sha === head ? known : null;
	const base = `/repos/${row.repo}/commits/${head}`;

	// Each listing keeps its ETag for this commit, saved with what it saw in
	// one transaction below, so a 304 always has the data it stands for.
	const etagFor = (key: string) => {
		const cursor = loadCursor(db, key);
		return previous !== null && cursor?.since === head
			? (cursor.etag ?? null)
			: null;
	};
	const runsKey = `${row.id}:check-runs`;
	let runs = previous?.runs ?? [];
	const runsChanged: CiRun[] = [];
	let runsEtag = etagFor(runsKey);
	let total = Infinity;
	for (
		let page = 1;
		runsChanged.length < total && page <= REVIEW_PAGES;
		page++
	) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		const response = await api.request(
			'GET',
			`${base}/check-runs?per_page=${PER_PAGE}&page=${page}`,
			{ etag: page === 1 ? runsEtag : null },
		);
		if (response.status === 304) break;
		if (page === 1) runsEtag = response.etag;
		const listed = field(response.body, 'check_runs');
		const batch = Array.isArray(listed) ? listed : [];
		total = Number(field(response.body, 'total_count') ?? batch.length);
		runsChanged.push(
			...batch.map((run) => ({
				id: idOf(field(run, 'id')),
				name: text(run, 'name'),
				status: text(run, 'status'),
				conclusion: text(run, 'conclusion'),
				url: text(run, 'html_url') || text(run, 'details_url'),
			})),
		);
		if (batch.length < PER_PAGE) break;
	}
	if (Number.isFinite(total)) runs = runsChanged;

	// The combined state covers every status; the list itself is paged.
	const statusKey = `${row.id}:status`;
	let statuses = previous?.statuses ?? [];
	let combined = previous?.combined ?? 'pending';
	let statusTotal = previous?.statusTotal ?? statuses.length;
	let statusEtag = etagFor(statusKey);
	const listedStatuses: CiStatus[] = [];
	for (let page = 1; page <= REVIEW_PAGES; page++) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		const response = await api.request(
			'GET',
			`${base}/status?per_page=${PER_PAGE}&page=${page}`,
			{ etag: page === 1 ? statusEtag : null },
		);
		if (response.status === 304) break;
		const listed = field(response.body, 'statuses');
		const batch = Array.isArray(listed) ? listed : [];
		if (page === 1) {
			statusEtag = response.etag;
			combined = text(response.body, 'state') || 'pending';
			statusTotal = Number(field(response.body, 'total_count') ?? batch.length);
		}
		listedStatuses.push(
			...batch.map((entry) => ({
				context: text(entry, 'context'),
				state: text(entry, 'state'),
				url: text(entry, 'target_url'),
			})),
		);
		statuses = listedStatuses;
		if (batch.length < PER_PAGE || listedStatuses.length >= statusTotal) {
			break;
		}
	}

	const failing = [
		...runs
			.filter(
				(run) => run.status === 'completed' && CI_FAILED.has(run.conclusion),
			)
			.map((run) => run.name),
		...statuses
			.filter((entry) => entry.state === 'failure' || entry.state === 'error')
			.map((entry) => entry.context),
	];
	const statusFailed = combined === 'failure' || combined === 'error';
	if (
		statusFailed &&
		!statuses.some(
			(entry) => entry.state === 'failure' || entry.state === 'error',
		)
	) {
		failing.push('a commit status not listed');
	}
	const checks = runs.length + statusTotal;
	const outcome: Ci['outcome'] =
		checks === 0
			? null
			: runs.some((run) => run.status !== 'completed') ||
				  (statusTotal > 0 && combined === 'pending')
				? 'pending'
				: failing.length > 0
					? 'failure'
					: 'success';
	let sent = previous?.sent ?? null;
	if (
		(outcome === 'failure' || outcome === 'success') &&
		!(sent?.sha === head && sent.outcome === outcome)
	) {
		const passed =
			runs.filter(
				(run) => run.status === 'completed' && CI_PASSED.has(run.conclusion),
			).length +
			(combined === 'success'
				? statusTotal
				: statuses.filter((entry) => entry.state === 'success').length);
		const short = head.slice(0, 7);
		// A re-run that ends the same way again is a new event.
		const key = `ci:${row.repo}:${head}:${outcome}:${sent?.sha === head ? Date.now() : 0}`;
		ingest(daemon, {
			channel: 'github',
			externalId: key,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'ci',
			author: { name: 'CI', id: null, isBot: false, isSelf: false },
			text:
				outcome === 'failure'
					? `CI failed on ${short}: ${andList(failing)} failed; ${passed} of ${checks} passed. gh pr checks ${row.number} and gh run view --log-failed show why.`
					: `CI passed on ${short} (${checks} ${checks === 1 ? 'check' : 'checks'})`,
			mentionsAgent: false,
			data: {
				...eventData(row, row.url ?? '', Date.now()),
				sha: head,
				outcome,
				failing: [
					...runs
						.filter(
							(run) =>
								run.status === 'completed' && CI_FAILED.has(run.conclusion),
						)
						.map((run) => ({ name: run.name, id: run.id, url: run.url })),
					...statuses
						.filter(
							(entry) => entry.state === 'failure' || entry.state === 'error',
						)
						.map((entry) => ({
							name: entry.context,
							id: null,
							url: entry.url,
						})),
				],
			},
		});
		sent = { sha: head, outcome, key };
	}
	const ci: Ci = {
		sha: head,
		runs,
		statuses,
		statusTotal,
		combined,
		outcome,
		failing,
		sent,
	};
	summary.ci = ci;
	db.transaction(() => {
		db.query<unknown, Params>(
			`UPDATE github_items SET summary = $summary, ci_outcome = $outcome
			WHERE thread_id = $id`,
		).run({
			id: row.id,
			summary: JSON.stringify(summary),
			outcome: sent?.sha === head ? sent.outcome : null,
		});
		saveCursor(db, runsKey, head, runsEtag);
		saveCursor(db, statusKey, head, statusEtag);
	})();
}

// Written by pollCi itself, so its shape is trusted once these hold.
function isCi(value: unknown): value is Ci {
	return (
		typeof field(value, 'sha') === 'string' &&
		Array.isArray(field(value, 'runs')) &&
		Array.isArray(field(value, 'statuses'))
	);
}

/** `a`, `a and b`, `a, b and c`. */
function andList(names: string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const REVIEW_WORDS: Record<string, string> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes requested',
	COMMENTED: 'commented',
};

/**
 * Reviews submitted since the PR was followed: with a body, a message;
 * an approval or a change request without one, an activity. A comment-only
 * review without a body is skipped, since its line comments arrive on
 * their own.
 *
 * GitHub lists reviews oldest first, with no `since`, so new ones land on
 * the last page. Polling starts from the stored page: an unchanged page is
 * a `304`, a full page moves the cursor to the next one, and only the
 * pages from there on are read.
 */
async function pollReviews(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const key = `${row.id}:reviews`;
	const cursor = loadCursor(daemon.db, key);
	const since = cursor?.since ?? new Date().toISOString();
	let page = cursor?.page ?? 1;
	let etag = cursor?.etag ?? null;
	const items: unknown[] = [];
	for (let read = 0; read < REVIEW_PAGES; read++) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		const response = await api.request(
			'GET',
			`/repos/${row.repo}/pulls/${row.number}/reviews?per_page=${PER_PAGE}&page=${page}`,
			{ etag },
		);
		if (response.status === 304) break;
		const batch = Array.isArray(response.body) ? response.body : [];
		items.push(...batch);
		if (batch.length < PER_PAGE) {
			({ etag } = response);
			break;
		}
		// Full: the next review goes on the next page.
		page += 1;
		etag = null;
	}
	saveCursor(daemon.db, key, since, etag, page);
	if (items.length === 0) return;
	const summary = summaryOf(daemon.db, row.id);
	const known = field(summary, 'reviews');
	const latest: Record<string, string> =
		typeof known === 'object' && known !== null ? { ...known } : {};
	for (const review of items) {
		const state = text(review, 'state');
		const word = REVIEW_WORDS[state];
		const who = login(review) || 'someone';
		if (word !== undefined && state !== 'COMMENTED') latest[who] = word;
		const submitted = text(review, 'submitted_at');
		if (word === undefined || submitted < since) continue;
		const body = redact(daemon.secrets, text(review, 'body'));
		if (body === '' && state === 'COMMENTED') continue;
		const userId = idOf(field(field(review, 'user'), 'id'));
		ingest(daemon, {
			channel: 'github',
			externalId: `review:${idOf(field(review, 'id')) ?? '?'}`,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: body === '' ? 'activity' : 'message',
			author: {
				name: who,
				id: userId,
				isBot: isBot(review),
				isSelf: body.includes(MARKER),
			},
			text:
				body === ''
					? state === 'APPROVED'
						? `${who} approved #${row.number}`
						: `${who} requested changes on #${row.number}`
					: `Review (${word}): ${body}`,
			mentionsAgent: false,
			data: {
				...eventData(row, text(review, 'html_url'), Date.parse(submitted)),
				review: field(review, 'id'),
			},
		});
	}
	summary.reviews = latest;
	daemon.db
		.query<unknown, [string, string]>(
			'UPDATE github_items SET summary = ? WHERE thread_id = ?',
		)
		.run(JSON.stringify(summary), row.id);
}

/**
 * Each active task in a GitHub repository with no open PR followed yet:
 * a PR from its branch, `superagent/<handle>`, opened with `gh pr create`
 * or by hand. A new one is followed by the task, signed, and announced to
 * its Worker.
 */
async function findTaskPrs(daemon: Daemon, api: GitHubApi): Promise<void> {
	const tasks = daemon.db
		.query<{ id: number; handle: string; repo: string }, []>(
			`SELECT t.id, t.handle, t.repo FROM tasks t
			WHERE t.state IN ('active', 'needs_you') AND t.repo IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM threads th JOIN github_items gi ON gi.thread_id = th.id
					WHERE th.owner_task_id = t.id AND gi.is_pr = 1 AND gi.state = 'open'
				)
			ORDER BY t.id`,
		)
		.all();
	for (const task of tasks) {
		const repo = daemon.github.repos.find((entry) => entry.name === task.repo);
		if (!repo) continue;
		const owner = repo.fullName.split('/')[0] ?? '';
		const key = `task:${task.handle}:pr`;
		const cursor = loadCursor(daemon.db, key);
		let response: GitHubResponse;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			response = await api.request(
				'GET',
				`/repos/${repo.fullName}/pulls?head=${encodeURIComponent(`${owner}:superagent/${task.handle}`)}&state=open&per_page=10`,
				{ etag: cursor?.etag ?? null },
			);
		} catch (error) {
			if (
				!(error instanceof GitHubError) ||
				error.status === 401 ||
				error.rateLimited
			) {
				throw error;
			}
			if (error.status === null || error.status >= 500) throw error;
			daemon.log('warn', 'couldn’t look up the task’s PR', {
				task: task.handle,
				error: error.message,
			});
			continue;
		}
		saveCursor(daemon.db, key, null, response.etag);
		if (response.status === 304 || !Array.isArray(response.body)) continue;
		const pr = response.body
			.filter((item) => typeof field(item, 'number') === 'number')
			.toSorted(
				(a, b) => Number(field(b, 'number')) - Number(field(a, 'number')),
			)[0];
		if (pr === undefined) continue;
		// oxlint-disable-next-line eslint/no-await-in-loop
		await followPr(daemon, api, task, repo, pr);
	}
}

async function followPr(
	daemon: Daemon,
	api: GitHubApi,
	task: { id: number; handle: string },
	repo: { name: string; fullName: string },
	pr: unknown,
): Promise<void> {
	const { db } = daemon;
	const number = Number(field(pr, 'number'));
	const id = ensureThread(daemon, repo, number, text(pr, 'html_url'));
	const owner = db
		.query<{ owner: number | null }, [string]>(
			'SELECT owner_task_id AS owner FROM threads WHERE id = ?',
		)
		.get(id)?.owner;
	if (owner !== null && owner !== undefined && owner !== task.id) return;
	const at = Date.now();
	// From the PR's creation, so comments posted before it was found still come.
	const since = text(pr, 'created_at') || new Date(at).toISOString();
	db.transaction(() => {
		db.query<unknown, [number, string]>(
			'UPDATE threads SET owner_task_id = ? WHERE id = ?',
		).run(task.id, id);
		db.query<unknown, [number, string, number]>(
			'INSERT OR IGNORE INTO task_threads (task_id, thread_id, since) VALUES (?, ?, ?)',
		).run(task.id, id, at);
		db.query<unknown, Params>(
			`INSERT INTO github_items (thread_id, repo, number, is_pr, title, state, head_sha,
				polled_at, updated_at)
			VALUES ($id, $repo, $number, 1, $title, 'open', $head, $at, $updated)
			ON CONFLICT (thread_id) DO UPDATE SET state = 'open', title = excluded.title`,
		).run({
			id,
			repo: repo.fullName,
			number,
			title: text(pr, 'title'),
			head: text(field(pr, 'head'), 'sha') || null,
			at,
			updated: text(pr, 'updated_at'),
		});
		for (const suffix of ['comments', 'review-comments', 'reviews']) {
			if (loadCursor(db, `${id}:${suffix}`) === null) {
				saveCursor(db, `${id}:${suffix}`, since, null);
			}
		}
	})();
	publishTask(daemon, task.id);
	daemon.log('info', 'following the task’s PR', {
		task: task.handle,
		thread: id,
	});
	ingest(daemon, {
		channel: 'internal',
		externalId: null,
		thread: null,
		kind: 'note',
		author: { name: 'the agent', id: null, isBot: false, isSelf: false },
		text: `You now follow ${id}, the PR from your branch superagent/${task.handle}: ${JSON.stringify(text(pr, 'title'))}. Its comments, reviews and merge come to you. wait_for them instead of finishing; you can finish once it's merged or closed.`,
		mentionsAgent: false,
		taskId: task.id,
	});
	const body = text(pr, 'body');
	if (body.includes(MARKER)) return;
	try {
		await api.request('PATCH', `/repos/${repo.fullName}/pulls/${number}`, {
			body: {
				body: `${body}${body ? '\n\n' : ''}${signOff(daemon, task.handle, `t${task.handle}`)}`,
			},
		});
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
		daemon.log('warn', 'couldn’t sign the PR', {
			thread: id,
			error: error.message,
		});
	}
}

/** The JSON `read_thread` shows for a PR: mergeable, draft, latest review per reviewer. */
function summaryOf(db: Database, threadId: string): Record<string, unknown> {
	const raw =
		db
			.query<{ summary: string | null }, [string]>(
				'SELECT summary FROM github_items WHERE thread_id = ?',
			)
			.get(threadId)?.summary ?? null;
	const value: unknown = raw === null ? null : JSON.parse(raw);
	return typeof value === 'object' && value !== null ? { ...value } : {};
}

function eventData(
	row: ItemRow,
	url: string,
	postedAt: number,
): Record<string, unknown> {
	return {
		repo: row.repo,
		number: row.number,
		isPr: row.isPr === 1,
		itemTitle: row.itemTitle,
		url,
		postedAt: Number.isFinite(postedAt) ? postedAt : null,
	};
}

/** What the Router's `read_thread` adds for a GitHub thread: the last polled state. */
export function githubThreadState(
	db: Database,
	threadId: string,
): string | null {
	const item = db
		.query<
			{
				isPr: number;
				title: string;
				state: string;
				head: string | null;
				polledAt: number;
			},
			[string]
		>(
			`SELECT is_pr AS isPr, title, state, head_sha AS head, polled_at AS polledAt
			FROM github_items WHERE thread_id = ?`,
		)
		.get(threadId);
	if (!item) return null;
	const seconds = Math.max(0, Math.round((Date.now() - item.polledAt) / 1000));
	const parts = [
		`GitHub ${item.isPr ? 'PR' : 'issue'}`,
		item.state,
		JSON.stringify(item.title),
	];
	if (item.isPr) {
		const summary = summaryOf(db, threadId);
		if (item.head) parts.push(`head ${item.head.slice(0, 7)}`);
		if (summary.draft === true) parts.push('draft');
		if (summary.mergeable === false) parts.push('has conflicts');
		const ci = field(summary, 'ci');
		const outcome = field(ci, 'outcome');
		if (outcome === 'failure') {
			const failing = field(ci, 'failing');
			parts.push(
				`CI failed: ${Array.isArray(failing) ? failing.map(String).join(', ') : ''}`,
			);
		} else if (outcome === 'success') {
			parts.push('CI passed');
		} else if (outcome === 'pending') {
			parts.push('CI running');
		}
		const reviews = field(summary, 'reviews');
		if (typeof reviews === 'object' && reviews !== null) {
			const entries = Object.entries(reviews);
			if (entries.length > 0) {
				parts.push(
					`reviews: ${entries.map(([who, word]) => `${who} ${String(word)}`).join(', ')}`,
				);
			}
		}
	}
	parts.push(`as of ${seconds} s ago`);
	return parts.join(' · ');
}

type Cursor = {
	since: string | null;
	etag: string | null;
	page: number | null;
};

function loadCursor(db: Database, key: string): Cursor | null {
	return db
		.query<Cursor, [string]>(
			'SELECT since, etag, page FROM github_cursors WHERE key = ?',
		)
		.get(key);
}

function saveCursor(
	db: Database,
	key: string,
	since: string | null,
	etag: string | null,
	page: number | null = null,
): void {
	db.query<unknown, Params>(
		`INSERT INTO github_cursors (key, since, etag, page, updated_at)
		VALUES ($key, $since, $etag, $page, $at)
		ON CONFLICT (key) DO UPDATE SET since = excluded.since, etag = excluded.etag,
			page = excluded.page, updated_at = excluded.updated_at`,
	).run({ key, since, etag, page, at: Date.now() });
}

function itemState(issue: unknown): string {
	if (field(field(issue, 'pull_request'), 'merged_at') !== null) {
		return 'merged';
	}
	return text(issue, 'state') === 'closed' ? 'closed' : 'open';
}

function clip(daemon: Daemon, value: string): string {
	const shown = cut(redact(daemon.secrets, value), INTRO_CHARS);
	return shown.length < value.length ? `${shown} […]` : shown;
}

function login(value: unknown): string {
	const user = field(value, 'user') ?? value;
	return text(user, 'login');
}

function isBot(comment: unknown): boolean {
	return text(field(comment, 'user'), 'type') === 'Bot';
}

function idOf(value: unknown): string | null {
	return typeof value === 'number' || typeof value === 'string'
		? String(value)
		: null;
}

function text(value: unknown, key: string): string {
	const found = field(value, key);
	return typeof found === 'string' ? found : '';
}

/** A property of a JSON value, or `null`. */
function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return null;
	}
	const record: Record<string, unknown> = { ...value };
	return record[key] ?? null;
}
