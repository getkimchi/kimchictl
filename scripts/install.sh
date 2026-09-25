#!/bin/sh
# kimchictl installer — downloads the latest (or pinned) prebuilt binary from
# GitHub Releases and installs it to a bin dir.
#
#   curl -fsSL https://raw.githubusercontent.com/getkimchi/kimchictl/main/scripts/install.sh | sh
#
# Honored env vars:
#   VERSION                 pin a release (e.g. "0.2.0"); default: latest
#   KIMCHICTL_INSTALL       bin dir; default: /usr/local/bin (or ~/.local/bin if not writable)
#   KIMCHICTL_NO_SSH_SETUP  if set, skip the post-install SSH integration step
set -eu

REPO="getkimchi/kimchictl"
BIN_NAME="kimchictl"

log() { printf '%s\n' "$*"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

need() {
	command -v "$1" >/dev/null 2>&1 || fail "install requires '$1'"
}

detect_platform() {
	case "$(uname -s)" in
		Darwin) os="darwin" ;;
		Linux) os="linux" ;;
		*) fail "unsupported OS: $(uname -s) (build from source or use npm)" ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch="arm64" ;;
		x86_64 | amd64) arch="x64" ;;
		*) fail "unsupported architecture: $(uname -m)" ;;
	esac
	printf '%s-%s' "$os" "$arch"
}

pick_bin_dir() {
	if [ -n "${KIMCHICTL_INSTALL:-}" ]; then
		printf '%s' "$KIMCHICTL_INSTALL"
	elif [ -w /usr/local/bin ] || [ "$(id -u)" = "0" ]; then
		printf '%s' "/usr/local/bin"
	else
		printf '%s' "${HOME}/.local/bin"
	fi
}

download() {
	url="$1"
	out="$2"
	curl -fsSL "$url" -o "$out"
}

sha256_of() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		printf ''
	fi
}

main() {
	need curl
	need uname

	platform="$(detect_platform)"
	bin_dir="$(pick_bin_dir)"

	if [ -n "${VERSION:-}" ]; then
		base="https://github.com/${REPO}/releases/download/${VERSION}"
	else
		base="https://github.com/${REPO}/releases/latest/download"
	fi
	asset="${BIN_NAME}-${platform}"

	tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t kimchictl)"
	trap 'rm -rf "$tmp_dir"' EXIT INT TERM

	log "> downloading ${asset} ($( [ -n "${VERSION:-}" ] && echo "v${VERSION}" || echo "latest" ))"
	download "${base}/${asset}" "${tmp_dir}/${BIN_NAME}"

	expected="$(download "${base}/checksums.txt" "${tmp_dir}/checksums.txt"; grep " ${asset}\$" "${tmp_dir}/checksums.txt" | cut -d' ' -f1)"
	if [ -n "$expected" ]; then
		actual="$(sha256_of "${tmp_dir}/${BIN_NAME}")"
		if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
			fail "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
		fi
	fi

	mkdir -p "$bin_dir"
	if ! mv "${tmp_dir}/${BIN_NAME}" "${bin_dir}/${BIN_NAME}" 2>/dev/null; then
		log "> no write permission to ${bin_dir} — retrying with sudo"
		sudo mv "${tmp_dir}/${BIN_NAME}" "${bin_dir}/${BIN_NAME}"
	fi
	chmod +x "${bin_dir}/${BIN_NAME}" 2>/dev/null || sudo chmod +x "${bin_dir}/${BIN_NAME}"

	log "✓ installed kimchictl to ${bin_dir}/${BIN_NAME}"
	case ":${PATH}:" in
		*":${bin_dir}:"*) ;;
		*) log "  note: ${bin_dir} is not on your PATH — add it before running kimchictl" ;;
	esac

	# Native SSH integration is configured automatically at install time
	# (writes ~/.config/kimchi/kimchictl/ssh_config + an Include block in ~/.ssh/config).
	if [ -n "${KIMCHICTL_NO_SSH_SETUP:-}" ]; then
		log "  skipped SSH integration (KIMCHICTL_NO_SSH_SETUP)"
	elif "${bin_dir}/${BIN_NAME}" ssh setup >/dev/null 2>&1; then
		log "✓ SSH integration configured (undo: kimchictl ssh setup --uninstall)"
	else
		log "  note: run 'kimchictl ssh setup' after installation to finish SSH integration"
	fi

	log ""
	log "Next: kimchictl login"
	log "Then: kimchictl workspace create"
}

main "$@"
