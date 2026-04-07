#!/usr/bin/env sh
# shellcheck shell=sh
set -eu

# -----------------------------------------------------------------------------
# claude-oauth installer
# https://github.com/4i3n6/clw-auth
#
# Supports: macOS, Linux
# Requires: Node.js >= 18, git, curl
# Installs: ~/.local/share/clw-auth (repo) + ~/.local/bin/claude-oauth (symlink)
# Idempotent: re-running updates to the latest release.
# -----------------------------------------------------------------------------

REPO_URL="https://github.com/4i3n6/clw-auth.git"
INSTALL_DIR="${CLWAUTH_INSTALL_DIR:-$HOME/.local/share/clw-auth}"
BIN_DIR="${CLWAUTH_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="claude-oauth"
BIN_PATH="$BIN_DIR/$BIN_NAME"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# Detect color support — skip colors when not a TTY or when NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _green='\033[0;32m'
  _red='\033[0;31m'
  _yellow='\033[1;33m'
  _cyan='\033[0;36m'
  _bold='\033[1m'
  _dim='\033[2m'
  _reset='\033[0m'
else
  _green='' _red='' _yellow='' _cyan='' _bold='' _dim='' _reset=''
fi

ok()   { printf "  ${_green}✔${_reset}  %s\n" "$1"; }
fail() { printf "  ${_red}✖${_reset}  %s\n" "$1" >&2; }
warn() { printf "  ${_yellow}!${_reset}  %s\n" "$1"; }
info() { printf "  ${_cyan}›${_reset}  %s\n" "$1"; }
gap()  { printf "\n"; }
rule() { printf "  ${_dim}%s${_reset}\n" "──────────────────────────────────────────────────"; }

die() {
  fail "$1"
  shift
  for msg in "$@"; do
    info "$msg"
  done
  gap
  exit 1
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

gap
printf "  ${_bold}${_cyan}claude-oauth${_reset} ${_dim}installer${_reset}\n"
rule
gap

# ---------------------------------------------------------------------------
# OS check — macOS and Linux only
# ---------------------------------------------------------------------------

OS=$(uname -s 2>/dev/null || echo "unknown")

case "$OS" in
  Darwin) ;;
  Linux)  ;;
  *)
    die "Unsupported OS: $OS" \
        "claude-oauth supports macOS and Linux only." \
        "See https://github.com/4i3n6/clw-auth for manual installation."
    ;;
esac

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

info "Checking Node.js..."

if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found." \
      "Install Node.js >= 18 at https://nodejs.org"
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)" 2>/dev/null || echo "")
NODE_MAJOR=$(printf "%s" "$NODE_VERSION" | cut -d. -f1)

if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_VERSION found — version 18 or higher is required." \
      "Install a newer version at https://nodejs.org"
fi

ok "Node.js $NODE_VERSION"

info "Checking git..."

if ! command -v git >/dev/null 2>&1; then
  die "git not found." \
      "Install git and try again."
fi

ok "git $(git --version 2>/dev/null | awk '{print $3}')"

gap

# ---------------------------------------------------------------------------
# Install or update
# ---------------------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  # Already installed — fetch latest release tag and update.
  CURRENT=$(grep '"version"' "$INSTALL_DIR/package.json" 2>/dev/null \
    | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/' || echo "unknown")

  info "Already installed (v$CURRENT). Checking for updates..."

  if ! git -C "$INSTALL_DIR" fetch --tags --quiet 2>/dev/null; then
    warn "Could not reach GitHub — skipping update check."
  else
    LATEST_TAG=$(git -C "$INSTALL_DIR" tag --sort=-v:refname \
      | grep '^v' | head -1 || echo "")

    if [ -n "$LATEST_TAG" ]; then
      LATEST=$(printf "%s" "$LATEST_TAG" | sed 's/^v//')

      if [ "$LATEST" = "$CURRENT" ]; then
        ok "Already on latest (v$CURRENT)."
        gap
      else
        info "Updating v$CURRENT → v$LATEST..."
        git -C "$INSTALL_DIR" checkout --quiet "$LATEST_TAG"
        ok "Updated to v$LATEST."
        gap
      fi
    else
      git -C "$INSTALL_DIR" pull --quiet --ff-only
      ok "Repository updated."
      gap
    fi
  fi
else
  # Fresh install — clone latest release tag.
  info "Installing to $INSTALL_DIR..."

  # Resolve latest release tag from remote (fallback: master).
  LATEST_TAG=$(git ls-remote --tags --sort="-v:refname" "$REPO_URL" 'refs/tags/v*' 2>/dev/null \
    | grep -v '\^{}' | head -1 | sed 's|.*refs/tags/||' || echo "")
  TARGET="${LATEST_TAG:-master}"

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if ! git clone --quiet --branch "$TARGET" --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    # Fallback: clone default branch without --branch if the tag doesn't exist locally.
    git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi

  ok "Cloned to $INSTALL_DIR (${TARGET})"
  gap
fi

# ---------------------------------------------------------------------------
# Binary setup
# ---------------------------------------------------------------------------

info "Setting up binary..."

# Ensure cli.mjs is executable.
chmod +x "$INSTALL_DIR/src/cli.mjs"

# Create ~/.local/bin if missing.
mkdir -p "$BIN_DIR"

# Replace existing symlink if pointing elsewhere; never overwrite a real file.
if [ -L "$BIN_PATH" ]; then
  rm "$BIN_PATH"
elif [ -e "$BIN_PATH" ]; then
  die "$BIN_PATH already exists and is not a symlink." \
      "Remove it manually and re-run the installer."
fi

ln -s "$INSTALL_DIR/src/cli.mjs" "$BIN_PATH"
ok "$BIN_NAME → $BIN_PATH"

gap

# ---------------------------------------------------------------------------
# PATH check
# ---------------------------------------------------------------------------

info "Checking PATH..."

case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "$BIN_DIR is in PATH."
    ;;
  *)
    warn "$BIN_DIR is not in your PATH."
    gap

    # Detect the right rc file for the current shell.
    case "${SHELL:-}" in
      */zsh)  RC_FILE="$HOME/.zshrc"  ;;
      */bash) RC_FILE="$HOME/.bashrc" ;;
      *)      RC_FILE="$HOME/.profile" ;;
    esac

    printf "  Add this line to %s${_bold}%s${_reset}:\n" "" "$RC_FILE"
    gap
    printf '    export PATH="$HOME/.local/bin:$PATH"\n'
    gap
    printf "  Then reload: ${_bold}source %s${_reset}\n" "$RC_FILE"
    gap

    # Offer to append automatically.
    if [ -t 0 ]; then
      printf "  Append automatically? [y/N] "
      read -r _answer </dev/tty || _answer="n"
      case "$_answer" in
        y|Y)
          printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC_FILE"
          ok "Added to $RC_FILE. Reload your shell to apply."
          ;;
        *)
          info "Skipped — add it manually when ready."
          ;;
      esac
      gap
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

info "Verifying installation..."

VERSION=$(grep '"version"' "$INSTALL_DIR/package.json" 2>/dev/null \
  | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/' || echo "unknown")

if node "$BIN_PATH" help >/dev/null 2>&1; then
  ok "claude-oauth v$VERSION is ready."
else
  warn "Installed but could not verify — check that Node.js is in PATH."
fi

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

gap
rule
gap
printf "  ${_bold}Setup wizard:${_reset}\n"
gap
printf "  ${_bold}  claude-oauth auth-setup${_reset}\n"
gap
printf "  ${_dim}Or manually:${_reset}\n"
gap
printf "  ${_dim}    claude-oauth oauth-url               Generate OAuth URL${_reset}\n"
printf "  ${_dim}    claude-oauth oauth-exchange <input>  Exchange code for tokens${_reset}\n"
printf "  ${_dim}    claude-oauth status                  Check auth status${_reset}\n"
printf "  ${_dim}    claude-oauth doctor                  Full diagnostic report${_reset}\n"
gap
