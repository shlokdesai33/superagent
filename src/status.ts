import type { Snapshot } from './protocol.ts';

/** The text `superagent status` prints. */
export function formatStatus(snapshot: Snapshot, home: string): string {
	const { agent, router, usage, health } = snapshot;
	const lines = [
		`Agent running · pid ${agent.pid} · up ${duration(snapshot.now - agent.startedAt)} · version ${agent.version}`,
		`Data folder: ${home}`,
	];

	if (snapshot.tasks.length === 0) {
		lines.push('Tasks: none');
	} else {
		lines.push(`Tasks: ${snapshot.tasks.length}`);
		for (const task of snapshot.tasks) {
			const status =
				task.status === 'waiting' && task.waitingOn
					? `waiting on ${task.waitingOn}`
					: task.status.replace('_', ' ');
			lines.push(`  ${task.handle}  ${status.padEnd(10)}  ${task.title}`);
		}
	}

	const routerParts = [
		router.deciding ? `deciding ${router.batchSize}` : 'idle',
	];
	if (router.waiting > 0) {
		routerParts.push(
			`${router.waiting} ${router.waiting === 1 ? 'event' : 'events'} waiting`,
		);
	}
	if (router.last) {
		routerParts.push(`last: ${router.last.text} at ${clock(router.last.at)}`);
	}
	lines.push(`Router: ${routerParts.join(' · ')}`);

	const last = snapshot.console.at(-1);
	lines.push(
		last
			? `Console: last message from ${last.author} at ${clock(last.at)}: ${JSON.stringify(oneLine(last.text))}`
			: 'Console: no messages yet',
	);

	lines.push(
		`Usage today: ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'} · ${(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} tokens · about $${usage.costUsd.toFixed(2)} (estimate)`,
		`Channels: ${health.channels
			.map(
				(channel) =>
					`${channel.name} ${channel.state}${channel.lastEventAt === null ? '' : ` (last event ${clock(channel.lastEventAt)})`}`,
			)
			.join(', ')}`,
		`Model: ${health.model.name} · ${health.model.state}${health.model.detail ? ` · ${health.model.detail}` : ''}`,
	);
	for (const problem of health.problems) {
		lines.push(`Problem: ${problem.text}`);
		if (problem.fix) lines.push(`  Fix: ${problem.fix}`);
	}
	lines.push(`Sandbox: ${health.sandbox}`);

	const tools = Object.entries(health.machine.tools);
	const missing = tools.filter(([, found]) => !found).map(([tool]) => tool);
	lines.push(
		`Machine: ${health.machine.os} · ${health.machine.arch} · tools: ${tools
			.filter(([, found]) => found)
			.map(([tool]) => tool)
			.join(
				', ',
			)}${missing.length > 0 ? ` · missing: ${missing.join(', ')}` : ''}`,
	);
	return lines.join('\n');
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24
		? `${hours}h ${minutes % 60}m`
		: `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function oneLine(text: string): string {
	const flat = text.replaceAll(/\s+/g, ' ').trim();
	return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
