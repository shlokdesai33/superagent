import type { Snapshot } from './protocol.ts';

/** The text `superagent status` prints. */
export function formatStatus(snapshot: Snapshot): string {
	const { agent, router, usage, health } = snapshot;
	const lines = [
		`Agent running · pid ${agent.pid} · up ${duration(snapshot.now - agent.startedAt)} · version ${agent.version}`,
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
	if (last) {
		lines.push(
			`Console: last message from ${last.author} at ${clock(last.at)}: ${JSON.stringify(oneLine(last.text))}`,
		);
	}

	lines.push(
		`Usage today: ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'} · ${(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} tokens (${usage.cachedTokens.toLocaleString('en-US')} cached input) · about $${usage.costUsd.toFixed(2)} (estimate)`,
		`Channels: ${health.channels
			.map(
				(channel) =>
					`${channel.name} ${channel.state}${channel.lastEventAt === null ? '' : ` (last event ${clock(channel.lastEventAt)})`}${channel.detail ? ` · ${channel.detail}` : ''}`,
			)
			.join(', ')}`,
		`Model: ${health.model.name} · ${health.model.state}${health.model.detail ? ` · ${health.model.detail}` : ''}`,
	);
	const key = keyText(health.model);
	if (key) lines.push(`Particle key: ${key}`);
	for (const problem of health.problems) {
		lines.push(`Problem: ${problem.text}`);
		if (problem.fix) lines.push(`  Fix: ${problem.fix}`);
	}
	for (const warning of health.warnings) {
		lines.push(`Warning: ${warning.text}`);
		if (warning.fix) lines.push(`  Fix: ${warning.fix}`);
	}

	lines.push(`Machine: ${health.machine.os} · ${health.machine.arch}`);
	return lines.join('\n');
}

/** Where the key comes from, only when that's the fix. */
function keyText(model: Snapshot['health']['model']): string | null {
	if (model.key === 'missing') return 'missing; run superagent login particle';
	if (model.key === 'env' && model.state === 'error') {
		return 'from PARTICLE_API_KEY';
	}
	return null;
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
