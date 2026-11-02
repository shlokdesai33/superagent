import { App } from './app.ts';
import { repositoryAt } from './repo.ts';
import { Terminal } from './terminal.ts';

/** Runs the terminal UI until the user quits. Restores the terminal on every exit. */
export async function runTui(): Promise<void> {
	const startedIn = repositoryAt(process.cwd());
	const terminal = new Terminal();
	const restore = () => terminal.leave();
	const onSignal = () => {
		restore();
		process.exit(0);
	};
	const onCrash = (error: unknown) => {
		restore();
		throw error;
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGHUP', onSignal);
	process.on('SIGINT', onSignal);
	process.on('uncaughtException', onCrash);
	process.on('exit', restore);

	terminal.start();
	try {
		const theme = await terminal.detectTheme();
		terminal.enter();
		const app = new App(terminal, theme, startedIn);
		app.start();
		await app.done;
	} finally {
		restore();
		process.off('SIGTERM', onSignal);
		process.off('SIGHUP', onSignal);
		process.off('SIGINT', onSignal);
		process.off('uncaughtException', onCrash);
		process.off('exit', restore);
	}
}
