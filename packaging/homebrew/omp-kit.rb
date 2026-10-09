# omp-kit.rb — Homebrew formula source of truth for omp-kit (rz5.59.4).
# Published to the tap (owner named by Josh on the bead before publication) by
# copying this file to Formula/omp-kit.rb with version/sha256 refreshed from
# release-index.json at each release (CONTRIBUTING.md Releases). Pinned to a
# published release; never to a tag under certification.
class OmpKit < Formula
  desc "Test OMP rules, preview every change, apply with receipts"
  homepage "https://github.com/JYeswak/omp-kit-companion"
  version "0.2.5"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/JYeswak/omp-kit-companion/releases/download/v0.2.5/omp-kit-v0.2.5-darwin-arm64-none.tar"
      sha256 "d722965da72361a979b1ecfb0cd939145a79b0543985b2963fdd63d7a70598d0"
    else
      url "https://github.com/JYeswak/omp-kit-companion/releases/download/v0.2.5/omp-kit-v0.2.5-darwin-x64-none.tar"
      sha256 "9adcd7c3f3e0e5adc84afce708ed3408f50514555a91685f5b49ab5ffdabcbb9"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/JYeswak/omp-kit-companion/releases/download/v0.2.5/omp-kit-v0.2.5-linux-arm64-gnu.tar"
      sha256 "863596e46bf2ba0989cd69268647ff90cfb178f8f96dc764cfcadf40cd935ec8"
    else
      url "https://github.com/JYeswak/omp-kit-companion/releases/download/v0.2.5/omp-kit-v0.2.5-linux-x64-gnu.tar"
      sha256 "83a788b9bd1c255c24b146bbbb85b58e6bceea9f5a6d58dc4f9fa196969abdf6"
    end
  end

  def install
    bin.install "bin/omp-kit"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omp-kit --version")
  end
end
