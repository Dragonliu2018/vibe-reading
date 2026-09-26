#!/usr/bin/env bash
# Backward-compatible installer. Lifecycle management lives in local-blog-ctl.sh.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/local-blog-ctl.sh" install
