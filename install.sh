#!/bin/sh
# Installs tesota on macOS or Linux from its GitHub Releases (#372), or updates it when run again:
#
#   curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/dev/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/dev/install.sh | sh -s -- 0.1.0-alpha.1
#
# With no version it installs the newest release, prereleases included. It picks the binary for this system,
# checks it against the release's SHA256SUMS before installing it, puts it in TESOTA_INSTALL_DIR (~/.tesota/bin
# unless set), and adds that folder to the PATH in your shell's startup file. TESOTA_DOWNLOAD replaces the
# release's download address, so CI installs the files it has just built.
set -eu

repository=sequelcore/tesota
install_dir=${TESOTA_INSTALL_DIR:-$HOME/.tesota/bin}

fail() { echo "tesota install: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "it needs curl"

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
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/tesota" | cut -d ' ' -f 1)
else actual=$(shasum -a 256 "$work/tesota" | cut -d ' ' -f 1); fi
[ "$actual" = "$expected" ] || fail "tesota-$target does not match its checksum, so it was not installed"

chmod +x "$work/tesota"
# Renamed in whole, so a tesota already running keeps its own file.
mv -f "$work/tesota" "$install_dir/tesota"
echo "Installed tesota $("$install_dir/tesota" --version) in $install_dir"

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
    echo "Open a new terminal to use tesota, or run: $line"
    ;;
esac
