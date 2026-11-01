export type Rgb = readonly [number, number, number];

export type Role =
	| 'bg'
	| 'surface'
	| 'flash'
	| 'fg'
	| 'dim'
	| 'faint'
	| 'ghost'
	| 'accent'
	| 'ok'
	| 'warn'
	| 'err'
	| 'okSoft'
	| 'errSoft'
	| 'okWord'
	| 'errWord';

export type ThemeName = 'dark' | 'light';
export type Theme = { name: ThemeName } & Record<Role, Rgb>;

// The design's exact values (tui-design.md §5); everything that isn't picked is
// a blend, written out so every contrast figure in the design holds.
const PALETTES: Record<ThemeName, Record<Role, string>> = {
	dark: {
		bg: '#16161B',
		surface: '#25252A',
		flash: '#2B283F',
		fg: '#E8E8EE',
		dim: '#ADADB3',
		faint: '#94949A',
		ghost: '#55555A',
		accent: '#9A88FF',
		ok: '#4AC492',
		warn: '#ECB04C',
		err: '#EE6258',
		okSoft: '#1E322E',
		errSoft: '#392225',
		okWord: '#274E41',
		errWord: '#5B2E2F',
	},
	light: {
		bg: '#FAFAFB',
		surface: '#EEEEEF',
		flash: '#EBE8F8',
		fg: '#1A1A1F',
		dim: '#505054',
		faint: '#6B6B6E',
		ghost: '#B7B7B9',
		accent: '#6244DC',
		ok: '#0E7850',
		warn: '#9C5C00',
		err: '#C2302A',
		okSoft: '#E2EDEA',
		errSoft: '#F4E6E6',
		okWord: '#C1DBD2',
		errWord: '#EDCAC9',
	},
};

export const THEMES: Record<ThemeName, Theme> = {
	dark: build('dark'),
	light: build('light'),
};

function build(name: ThemeName): Theme {
	const p = PALETTES[name];
	return {
		name,
		bg: hexToRgb(p.bg),
		surface: hexToRgb(p.surface),
		flash: hexToRgb(p.flash),
		fg: hexToRgb(p.fg),
		dim: hexToRgb(p.dim),
		faint: hexToRgb(p.faint),
		ghost: hexToRgb(p.ghost),
		accent: hexToRgb(p.accent),
		ok: hexToRgb(p.ok),
		warn: hexToRgb(p.warn),
		err: hexToRgb(p.err),
		okSoft: hexToRgb(p.okSoft),
		errSoft: hexToRgb(p.errSoft),
		okWord: hexToRgb(p.okWord),
		errWord: hexToRgb(p.errWord),
	};
}

function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `t` of the way from `a` to `b`, clamped. */
export function blend(a: Rgb, b: Rgb, t: number): Rgb {
	const k = Math.max(0, Math.min(1, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}

/**
 * The theme for a background colour from an OSC 11 reply such as
 * `rgb:1616/1616/1b1b`, or `null` when it can't be read.
 */
export function themeFromOsc11(reply: string): ThemeName | null {
	const match = reply.match(
		/rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i,
	);
	if (!match) return null;
	const [r, g, b] = [match[1], match[2], match[3]].map(
		(part = '0') => Number.parseInt(part, 16) / (16 ** part.length - 1),
	);
	return luminance(r ?? 0, g ?? 0, b ?? 0) > 0.5 ? 'light' : 'dark';
}

/** `COLORFGBG` is `fg;bg` (sometimes `fg;default;bg`); background 7 or 15 is light. */
export function themeFromColorFgBg(value: string | undefined): ThemeName {
	const background = value?.split(';').at(-1);
	return background === '7' || background === '15' ? 'light' : 'dark';
}

// Rec. 709 weights on the encoded values, so mid-grey sits near 0.5.
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
