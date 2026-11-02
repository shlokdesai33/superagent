#!/bin/sh
# Installs or updates superagent from its latest GitHub Release:
#
#   curl -fsSL https://github.com/shlokdesai33/superagent/releases/latest/download/install.sh | sh
#
# It downloads the executable for this machine, checks its SHA-256 checksum
# and puts it in ~/.local/bin (no sudo). Run it again to update.
#
# Settings, as environment variables:
#   SUPERAGENT_VERSION      a release tag such as v0.1.0 (default: the latest)
#   SUPERAGENT_INSTALL_DIR  where to put the executable (default: ~/.local/bin)
#   SUPERAGENT_RELEASE_URL  where release files are downloaded from, for testing
#   SUPERAGENT_DRY_RUN=1    print what would happen and change nothing
#                           (also: sh install.sh --dry-run)
set -eu

REPO="shlokdesai33/superagent"
dry_run="${SUPERAGENT_DRY_RUN:-}"
for arg in "$@"; do
	case "$arg" in
	--dry-run) dry_run=1 ;;
	*)
		echo "superagent install: unknown option $arg" >&2
		exit 1
		;;
	esac
done

say() { printf '%s\n' "$*"; }
fail() {
	printf 'superagent install: %s\n' "$*" >&2
	exit 1
}

case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) fail "superagent runs on macOS and Linux, not $(uname -s)" ;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "there is no superagent for $(uname -m) processors" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
	[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi
if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1 &&
	! ls /lib*/ld-linux-* /lib/*/ld-linux-* >/dev/null 2>&1; then
	fail "superagent needs glibc; musl-based Linux such as Alpine isn't supported"
fi

command -v curl >/dev/null 2>&1 || fail "curl is needed to download superagent"
if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "sha256sum or shasum is needed to check the download"
fi

asset="superagent-$os-$arch"
if [ -n "${SUPERAGENT_RELEASE_URL:-}" ]; then
	base="$SUPERAGENT_RELEASE_URL"
elif [ -n "${SUPERAGENT_VERSION:-}" ]; then
	base="https://github.com/$REPO/releases/download/$SUPERAGENT_VERSION"
else
	base="https://github.com/$REPO/releases/latest/download"
fi
dir="${SUPERAGENT_INSTALL_DIR:-${HOME:+$HOME/.local/bin}}"
[ -n "$dir" ] || fail "HOME isn't set; set SUPERAGENT_INSTALL_DIR to the folder to install superagent in"
dest="$dir/superagent"

previous=""
if [ -x "$dest" ]; then
	previous="$("$dest" --version 2>/dev/null || true)"
fi

if [ -n "$dry_run" ]; then
	say "Dry run; nothing is changed."
	say "Would download $base/$asset"
	say "  and check it against $base/$asset.sha256"
	say "Would install it as $dest${previous:+ (replacing $previous)}"
	exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/superagent-install.XXXXXX")"
# A trap that doesn't exit lets the script carry on after Ctrl-C, without $tmp.
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Braces: shells that take the first byte of "…" for a letter, such as
# macOS's /bin/sh, would otherwise read a variable named "asset\342".
say "Downloading ${asset}…"
curl -fSL --progress-bar -o "$tmp/$asset" "$base/$asset" ||
	fail "couldn't download $base/$asset"
curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" ||
	fail "couldn't download $base/$asset.sha256"

expected="$(cut -d ' ' -f 1 <"$tmp/$asset.sha256")"
actual="$(sha256 "$tmp/$asset")"
[ -n "$expected" ] && [ "$expected" = "$actual" ] ||
	fail "the download doesn't match its checksum (expected $expected, got $actual); nothing was installed"
mkdir -p "$dir"
cp "$tmp/$asset" "$dest.new"
chmod 755 "$dest.new"
if ! version="$("$dest.new" --version)"; then
	rm -f "$dest.new"
	fail "the downloaded superagent doesn't run on this machine; nothing was installed"
fi
# A rename, never an overwrite: a running agent keeps its old copy until it
# restarts, and macOS keeps trusting the new file's signature.
mv -f "$dest.new" "$dest"

if [ -z "$previous" ]; then
	say "Installed superagent $version in $dest"
elif [ "$previous" = "$version" ]; then
	say "superagent $version is already the latest; reinstalled it in $dest"
else
	say "Updated superagent $previous → $version in $dest"
fi

if [ -n "$previous" ] && [ "$previous" != "$version" ] &&
	"$dest" status >/dev/null 2>&1; then
	say "The background agent is still running $previous. Switch it to $version with: superagent restart"
fi

say ""
case ":$PATH:" in
*":$dir:"*) run="superagent" ;;
*)
	run="$dest"
	case "${SHELL:-}" in
	*/zsh) profile="~/.zshrc" ;;
	*/bash) profile="~/.bashrc" ;;
	*) profile="your shell's startup file" ;;
	esac
	say "$dir isn't on your PATH. To run superagent by name, add this to $profile:"
	say "  export PATH=\"$dir:\$PATH\""
	say ""
	;;
esac

command -v git >/dev/null 2>&1 ||
	say "superagent also needs git, which isn't installed. Install it first."
if [ -z "$previous" ]; then
	say "Next, open superagent and paste your Particle API key:"
	say "  $run"
fi
