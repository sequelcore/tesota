#!/bin/sh
# Installs tesota on macOS or Linux from its GitHub Releases (#372), or updates it when run again:
#
#   curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh -s -- 0.1.0-alpha.1
#   curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh -s -- dafny
#
# With no version it installs the newest release, prereleases included. It picks the binary for this system,
# checks it against the release's SHA256SUMS before installing it, puts it in TESOTA_INSTALL_DIR (~/.tesota/bin
# unless set), and adds that folder to the PATH in your shell's startup file. TESOTA_DOWNLOAD replaces the
# release's download address, so CI installs the files it has just built.
#
# With `dafny` it installs Dafny 4.11.0 instead: Dafny's own self-contained release, which needs no .NET,
# checked against the SHA-256 below, in ~/.tesota/tools/dafny, linked from the install folder.
set -eu

repository=sequelcore/tesota
install_dir=${TESOTA_INSTALL_DIR:-$HOME/.tesota/bin}

fail() { echo "tesota install: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "it needs curl"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

# Adds the install folder to the PATH in the shell's startup file, once.
add_to_path() {
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      case $(basename "${SHELL:-sh}") in
        zsh) profile=$HOME/.zshrc line="export PATH=\"$install_dir:\$PATH\"" ;;
        bash) profile=$HOME/.bashrc line="export PATH=\"$install_dir:\$PATH\""
          [ "$os" = darwin ] && profile=$HOME/.bash_profile ;;
        fish) profile=$HOME/.config/fish/config.fish line="fish_add_path \"$install_dir\"" ;;
        *) profile=$HOME/.profile line="export PATH=\"$install_dir:\$PATH\"" ;;
      esac
      if ! grep -qsF "$line" "$profile"; then
        mkdir -p "$(dirname "$profile")"
        printf '\n# tesota\n%s\n' "$line" >> "$profile"
        echo "Added $install_dir to the PATH in $profile."
      fi
      echo "Open a new terminal to use $1, or run: $line"
      ;;
  esac
}

install_dafny() {
  dafny_version=4.11.0
  # Digests from the release's own asset list. Dafny publishes no Linux arm64 or musl build.
  case $target in
    linux-x64 | linux-x64-baseline) asset=x64-ubuntu-22.04 sum=a46a9ff7cdd720f7955854c78e95df13f4cfe6b80691b05f8654fe19e8267179 ;;
    darwin-x64 | darwin-x64-baseline) asset=x64-macos-13 sum=5fc0de946c5b2fad33f16bd22a5b06f4fd0dfa7f6d770284237e3f1f3ca9f73d ;;
    darwin-arm64) asset=arm64-macos-13 sum=c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f ;;
    *) fail "Dafny $dafny_version has no build for $target; install Dafny 4 yourself from https://dafny.org" ;;
  esac
  command -v unzip >/dev/null 2>&1 || fail "installing Dafny needs unzip"
  tools=$HOME/.tesota/tools
  mkdir -p "$tools" "$install_dir"
  work=$(mktemp -d "$tools/.dafny.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  url=https://github.com/dafny-lang/dafny/releases/download/v$dafny_version/dafny-$dafny_version-$asset.zip
  echo "Downloading Dafny $dafny_version from $url"
  curl -fsSL -o "$work/dafny.zip" "$url" || fail "could not download $url"
  [ "$(sha256 "$work/dafny.zip")" = "$sum" ] || fail "dafny-$dafny_version-$asset.zip does not match its checksum, so it was not installed"
  unzip -q "$work/dafny.zip" -d "$work"
  rm -rf "$tools/dafny"
  mv "$work/dafny" "$tools/dafny"
  ln -sf "$tools/dafny/dafny" "$install_dir/dafny"
  echo "Installed Dafny $("$install_dir/dafny" --version) in $tools/dafny"
  add_to_path dafny
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no binary for $(uname -s); on Windows, use install.ps1" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no binary for $(uname -m)" ;;
esac
# A shell under Rosetta reports x64 on an Apple silicon Mac, which runs the arm64 binary natively.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; fi
target=$os-$arch
if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then target=$target-musl; fi
# x64 processors without AVX2 run the baseline build.
if [ "$arch" = x64 ]; then
  if [ "$os" = linux ]; then grep -qw avx2 /proc/cpuinfo 2>/dev/null || target=$target-baseline
  else sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2 || target=$target-baseline; fi
fi

if [ "${1:-}" = dafny ]; then install_dafny; exit 0; fi

if [ -n "${TESOTA_DOWNLOAD:-}" ]; then
  download=$TESOTA_DOWNLOAD
else
  version=${1:-${TESOTA_VERSION:-}}
  if [ -z "$version" ]; then
    version=$(curl -fsSL "https://api.github.com/repos/$repository/releases?per_page=1" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$version" ] || fail "could not find the newest release of $repository"
  fi
  download=https://github.com/$repository/releases/download/v${version#v}
fi

mkdir -p "$install_dir"
# Downloaded beside the install folder's tesota, so the move that installs it is a rename.
work=$(mktemp -d "$install_dir/.download.XXXXXX")
trap 'rm -rf "$work"' EXIT
echo "Downloading tesota-$target from $download"
curl -fsSL -o "$work/SHA256SUMS" "$download/SHA256SUMS" || fail "could not download $download/SHA256SUMS"
curl -fsSL -o "$work/tesota" "$download/tesota-$target" || fail "could not download $download/tesota-$target"

expected=$(sed -n "s/^\([0-9a-f]\{64\}\) [ *]tesota-$target\$/\1/p" "$work/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS lists no tesota-$target"
[ "$(sha256 "$work/tesota")" = "$expected" ] || fail "tesota-$target does not match its checksum, so it was not installed"

chmod +x "$work/tesota"
# Renamed in whole, so a tesota already running keeps its own file.
mv -f "$work/tesota" "$install_dir/tesota"
echo "Installed tesota $("$install_dir/tesota" --version) in $install_dir"
add_to_path tesota
