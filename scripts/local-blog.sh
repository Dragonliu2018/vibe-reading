#!/usr/bin/env bash
# Private-mode Astro preview. Invoked by systemd (Linux/WSL) or launchd
# (macOS); do not run a second copy alongside it.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd "$ROOT"

# launchd starts with a deliberately small PATH. Cover the common macOS and
# user-level Node install locations before loading nvm below.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims:$PATH"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; install Node.js >= 22.12 or make it available through nvm/Homebrew/Volta/asdf/mise." >&2
  exit 127
fi

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY='*'
export CONTENT_MODE=private

exec npm run dev:private -- --host 0.0.0.0 --port 4321
