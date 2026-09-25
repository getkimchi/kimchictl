#!/usr/bin/env bash
# Re-sign a bun-compiled macOS binary (usage: codesign.sh <binary>).
#
# Bun --compile produces binaries with an invalid code signature on macOS: the
# app payload is grafted onto a pre-signed runtime ("code or signature have
# been modified"), and the kernel kills badly-signed arm64 binaries outright
# (SIGKILL, exit 137). Every darwin binary must therefore be re-signed:
#   - CSC_NAME set (release CI, prepared by scripts/setup-codesign.sh):
#     hardened-runtime Developer ID + timestamp + entitlements. The designated
#     requirement becomes certificate-anchored, so the macOS keychain treats
#     every version as one identity — an ad-hoc identity is just the cdhash and
#     re-prompts users on each upgrade.
#   - CSC_NAME unset (local dev, forks): ad-hoc, enough for the OS to launch it.
# See: https://github.com/oven-sh/bun/issues/7208
set -euo pipefail

binary=${1:?usage: codesign.sh <binary>}
entitlements="$(cd "$(dirname "$0")/.." && pwd)/build/entitlements.mac.plist"

codesign --remove-signature "$binary"

if [ -n "${CSC_NAME:-}" ]; then
	codesign --sign "$CSC_NAME" --options runtime --timestamp --entitlements "$entitlements" "$binary"
	codesign --verify --strict --verbose=2 "$binary"
	# The keychain credential partition only stays put across versions when
	# the designated requirement anchors on the Developer ID certificate.
	# Fail loudly if we ever slip back to a cdhash-only requirement.
	if ! codesign -d -r- "$binary" 2>&1 | grep -q "anchor apple generic"; then
		echo "Designated requirement is not certificate-anchored — refusing to ship." >&2
		exit 1
	fi
else
	echo "CSC_NAME not set — ad-hoc signing (local dev / fork build)."
	codesign -s - "$binary"
	codesign --verify -v "$binary"
fi
