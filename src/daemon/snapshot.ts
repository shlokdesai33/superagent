import type { Snapshot } from '../protocol.ts';
import {
	type Daemon,
	consoleMessages,
	dayStart,
	health,
	routerState,
	usageSince,
} from './state.ts';
import { snapshotTasks } from './task-feed.ts';

/** The whole state, built synchronously so it matches the feed's `seq`. */
export function buildSnapshot(daemon: Daemon): Snapshot {
	const now = Date.now();
	const start = dayStart(now);
	return {
		now,
		agent: daemon.agent,
		day: {
			start,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
		tasks: snapshotTasks(daemon),
		console: consoleMessages(daemon.db),
		router: routerState(daemon),
		usage: usageSince(daemon.db, start),
		health: health(daemon),
		observed: [],
	};
}
