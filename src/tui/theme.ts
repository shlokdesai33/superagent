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
/** Whether the terminal shows 24-bit colour, or only the xterm 256 palette. */
export type ColorDepth = 'truecolor' | '256';
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

// For terminals without 24-bit colour (tui-design.md §5): xterm palette
// indexes, only 16–255, whose colours are fixed (0–15 follow the user's
// profile). Picked near each truecolor value with every word role at least
// 4.5:1 on `bg` and `surface`.
const PALETTES_256: Record<ThemeName, Record<Role, number>> = {
	dark: {
		bg: 233,
		surface: 235,
		flash: 236,
		fg: 254,
		dim: 145,
		faint: 246,
		ghost: 240,
		accent: 141,
		ok: 72,
		warn: 179,
		err: 203,
		okSoft: 234,
		errSoft: 234,
		okWord: 22,
		errWord: 52,
	},
	light: {
		bg: 231,
		surface: 255,
		flash: 254,
		fg: 234,
		dim: 239,
		faint: 242,
		ghost: 250,
		accent: 56,
		ok: 22,
		warn: 94,
		err: 124,
		okSoft: 194,
		errSoft: 224,
		okWord: 151,
		errWord: 217,
	},
};

const CUBE = [0, 95, 135, 175, 215, 255] as const;

export const THEMES: Record<ColorDepth, Record<ThemeName, Theme>> = {
	truecolor: {
		dark: build('dark', 'truecolor'),
		light: build('light', 'truecolor'),
	},
	'256': { dark: build('dark', '256'), light: build('light', '256') },
};

function build(name: ThemeName, depth: ColorDepth): Theme {
	const c = (role: Role): Rgb =>
		depth === 'truecolor'
			? hexToRgb(PALETTES[name][role])
			: xterm256(PALETTES_256[name][role]);
	return {
		name,
		bg: c('bg'),
		surface: c('surface'),
		flash: c('flash'),
		fg: c('fg'),
		dim: c('dim'),
		faint: c('faint'),
		ghost: c('ghost'),
		accent: c('accent'),
		ok: c('ok'),
		warn: c('warn'),
		err: c('err'),
		okSoft: c('okSoft'),
		errSoft: c('errSoft'),
		okWord: c('okWord'),
		errWord: c('errWord'),
	};
}

// How far each surface steps from the background (tui-design.md §5).
const STEPS: Record<
	ThemeName,
	{ surface: number; flash: number; soft: number; word: number }
> = {
	dark: { surface: 0.07, flash: 0.16, soft: 0.16, word: 0.32 },
	light: { surface: 0.055, flash: 0.1, soft: 0.1, word: 0.24 },
};
const GHOST_STEP = 0.3;
const MIN_CONTRAST = 4.5;
/** The least a 256-colour surface may differ from the background. */
const MIN_SURFACE_STEP = 1.06;
const WORDS = ['fg', 'dim', 'faint', 'accent', 'ok', 'warn', 'err'] as const;

/**
 * The theme for the terminal's own background, which the screen keeps:
 * surfaces step from it as the design's step from its `bg`, and each word
 * colour moves toward white (dark) or black (light) until it reads at 4.5:1
 * on it and on `surface`. With no reported background, the design's palette.
 */
export function themeFor(
	name: ThemeName,
	depth: ColorDepth,
	background: Rgb | null,
): Theme {
	const base = THEMES[depth][name];
	if (background === null) return base;
	const snap = (rgb: Rgb): Rgb =>
		depth === '256' ? xterm256(nearest256(rgb)) : rgb;
	const steps = STEPS[name];
	const extreme: Rgb = name === 'dark' ? [255, 255, 255] : [0, 0, 0];

	let k = steps.surface;
	let surface = snap(blend(background, base.fg, k));
	while (contrast(surface, background) < MIN_SURFACE_STEP && k < 0.5) {
		k += 0.01;
		surface = snap(blend(background, base.fg, k));
	}
	const readable = (color: Rgb): Rgb => {
		for (let t = 0; t <= 1; t += 0.02) {
			const candidate = snap(blend(color, extreme, t));
			if (
				contrast(candidate, background) >= MIN_CONTRAST &&
				contrast(candidate, surface) >= MIN_CONTRAST
			) {
				return candidate;
			}
		}
		return snap(extreme);
	};
	const theme: Theme = { ...base, bg: background, surface };
	for (const role of WORDS) theme[role] = readable(base[role]);
	// A tint toward `to`, backed off toward the background until `words` read on it.
	const tint = (to: Rgb, amount: number, words: Rgb[]): Rgb => {
		for (let t = amount; t > 0; t -= 0.02) {
			const candidate = snap(blend(background, to, t));
			if (words.every((word) => contrast(word, candidate) >= MIN_CONTRAST)) {
				return candidate;
			}
		}
		return surface;
	};
	theme.ghost = snap(blend(background, theme.fg, GHOST_STEP));
	theme.flash = snap(blend(background, theme.accent, steps.flash));
	theme.okSoft = tint(theme.ok, steps.soft, [theme.fg, theme.ok]);
	theme.errSoft = tint(theme.err, steps.soft, [theme.fg, theme.err]);
	theme.okWord = tint(theme.ok, steps.word, [theme.fg]);
	theme.errWord = tint(theme.err, steps.word, [theme.fg]);
	return theme;
}

/** The WCAG contrast ratio of two colours. */
export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].toSorted(
		(x, y) => y - x,
	);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function relativeLuminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((value) => {
		const s = value / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The colour xterm shows for palette index 16–255. */
export function xterm256(index: number): Rgb {
	if (index >= 232) {
		const level = 8 + 10 * (index - 232);
		return [level, level, level];
	}
	const n = index - 16;
	return [
		CUBE[Math.floor(n / 36)] ?? 0,
		CUBE[Math.floor(n / 6) % 6] ?? 0,
		CUBE[n % 6] ?? 0,
	];
}

const nearestCache = new Map<number, number>();

/**
 * The palette index (16–255) closest to `rgb`: exact for a 256-colour
 * theme's roles, nearest for the blends of fades and the sweep.
 */
export function nearest256(rgb: Rgb): number {
	const packed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
	const cached = nearestCache.get(packed);
	if (cached !== undefined) return cached;
	let best = 16;
	let bestDistance = Infinity;
	for (let index = 16; index < 256; index += 1) {
		const [r, g, b] = xterm256(index);
		// "Redmean" weights: cheap, and close to how far apart colours look.
		const mean = (rgb[0] + r) / 2;
		const dr = rgb[0] - r;
		const dg = rgb[1] - g;
		const db = rgb[2] - b;
		const distance =
			(2 + mean / 256) * dr * dr +
			4 * dg * dg +
			(2 + (255 - mean) / 256) * db * db;
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	nearestCache.set(packed, best);
	return best;
}

/** Terminal.app 2.15 (macOS 26) is the first with real 24-bit colour. */
const FIRST_TRUECOLOR_APPLE_TERMINAL = 464;
const TRUECOLOR_PROGRAMS = new Set([
	'iTerm.app',
	'WezTerm',
	'ghostty',
	'vscode',
	'Hyper',
	'Tabby',
	'WarpTerminal',
	'rio',
	'zed',
]);
const TRUECOLOR_TERMS =
	/^(?:xterm-kitty|xterm-ghostty|alacritty|foot|wezterm|contour)|-direct$/;

/**
 * Truecolor only on evidence: `COLORTERM`, or a terminal known to have it.
 * Everything else gets the 256 palette, which every terminal shows right;
 * a terminal without 24-bit colour misreads `38;2;r;g;b` as separate
 * attributes and paints, say, a green background.
 */
export function colorDepth(
	env: Record<string, string | undefined>,
): ColorDepth {
	// Its build number is the one thing known for sure, so it wins over a
	// `COLORTERM` exported by a shell profile.
	if (env.TERM_PROGRAM === 'Apple_Terminal') {
		const version = Number.parseInt(env.TERM_PROGRAM_VERSION ?? '', 10);
		return version >= FIRST_TRUECOLOR_APPLE_TERMINAL ? 'truecolor' : '256';
	}
	const declared = env.COLORTERM?.toLowerCase();
	if (declared === 'truecolor' || declared === '24bit') return 'truecolor';
	if (TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? '')) return 'truecolor';
	if (TRUECOLOR_TERMS.test(env.TERM ?? '')) return 'truecolor';
	if (env.WT_SESSION || env.KITTY_WINDOW_ID) return 'truecolor';
	return '256';
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
 * The background colour from an OSC 11 reply such as `rgb:1616/1616/1b1b`,
 * or `null` when it can't be read.
 */
export function backgroundFromOsc11(reply: string): Rgb | null {
	const match = reply.match(
		/rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i,
	);
	if (!match) return null;
	const [r = 0, g = 0, b = 0] = [match[1], match[2], match[3]].map(
		(part = '0') =>
			Math.round((Number.parseInt(part, 16) / (16 ** part.length - 1)) * 255),
	);
	return [r, g, b];
}

/** Light for a background above half luminance, else dark. */
export function themeOf(background: Rgb): ThemeName {
	const [r, g, b] = background.map((value) => value / 255);
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
