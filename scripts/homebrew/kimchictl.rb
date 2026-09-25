# Kimchictl formula rendered by .github/workflows/release.yml — edit the
# template here, never the generated file in getkimchi/homebrew-tap.
class Kimchictl < Formula
  desc "CLI for kimchi remote workspaces"
  homepage "https://github.com/getkimchi/kimchictl"
  version "@VERSION@"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/getkimchi/kimchictl/releases/download/@VERSION@/kimchictl-darwin-arm64"
      sha256 "@SHA_DARWIN_ARM64@"
    else
      url "https://github.com/getkimchi/kimchictl/releases/download/@VERSION@/kimchictl-darwin-x64"
      sha256 "@SHA_DARWIN_X64@"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/getkimchi/kimchictl/releases/download/@VERSION@/kimchictl-linux-arm64"
      sha256 "@SHA_LINUX_ARM64@"
    else
      url "https://github.com/getkimchi/kimchictl/releases/download/@VERSION@/kimchictl-linux-x64"
      sha256 "@SHA_LINUX_X64@"
    end
  end

  def install
    bin.install Dir["kimchictl-*"].first => "kimchictl"
  end

  def post_install
    # Native SSH integration is configured at install time. Opt out with
    # KIMCHICTL_NO_SSH_SETUP=1; undo with `kimchictl ssh setup --uninstall`.
    unless ENV["KIMCHICTL_NO_SSH_SETUP"]
      system bin/"kimchictl", "ssh", "setup"
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kimchictl version")
  end
end
