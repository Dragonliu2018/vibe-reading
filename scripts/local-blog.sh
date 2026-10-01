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

# Tailscale Serve preserves its MagicDNS Host header. Keep that machine-local
# value out of the repository while allowing Vite to accept the proxy request.
LOCAL_BLOG_HOST_FILE="$ROOT/.local-blog-host"
if [[ -r "$LOCAL_BLOG_HOST_FILE" ]]; then
  TAILSCALE_HOSTNAME="$(tr -d '[:space:]' < "$LOCAL_BLOG_HOST_FILE")"
  if [[ ! "$TAILSCALE_HOSTNAME" =~ ^[a-zA-Z0-9.-]+\.ts\.net$ ]]; then
    echo "Invalid Tailscale hostname in $LOCAL_BLOG_HOST_FILE" >&2
    exit 1
  fi
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$TAILSCALE_HOSTNAME"
  echo "Allowing additional Vite host: $TAILSCALE_HOSTNAME"
fi

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY='*'
export CONTENT_MODE=private

# Keep the toolbar available for desktop development. The shared layout policy
# hides it on touch-oriented devices.
./node_modules/.bin/astro preferences enable devToolbar >/dev/null

exec npm run dev:private -- --host 127.0.0.1 --port 4321
