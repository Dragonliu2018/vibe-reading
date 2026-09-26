#!/usr/bin/env bash
# Cross-platform lifecycle manager for the always-on private blog.
# Linux/WSL: systemd user template instance. macOS: per-user LaunchAgent.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
ACTION="${1:-status}"
PLATFORM="$(uname -s)"
PORT=4321
URL="http://127.0.0.1:${PORT}/vibe-reading/"

case "$ACTION" in
  help|-h|--help)
    # Help must work even on unsupported hosts or before system tools exist.
    HELP_ONLY=1
    ;;
  *)
    HELP_ONLY=0
    ;;
esac

usage() {
  cat <<'EOF'
Usage: bash scripts/local-blog-ctl.sh <command>

Commands:
  install    Install, enable, and start the per-user background service
  start      Enable and start an installed service
  stop       Stop and disable the service
  restart    Restart the service (and keep it enabled)
  status     Show service and HTTP status (default)
  logs       Follow service logs
  uninstall  Stop the service and remove its per-user registration
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required for this operation."
}

path_id() {
  printf '%s' "$ROOT" | cksum | awk '{print $1}'
}

http_status() {
  if ! command -v curl >/dev/null 2>&1; then
    return
  fi
  local code
  code="$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
    curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "$URL" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    echo "HTTP: $code $URL"
  else
    echo "HTTP: unavailable (${code:-no response}) $URL"
  fi
}

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null
}

install_wsl_startup() {
  is_wsl || return 0

  if command -v loginctl >/dev/null 2>&1; then
    if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
      if loginctl enable-linger "$USER" 2>/dev/null; then
        echo "Enabled systemd linger for $USER."
      elif sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
        echo "Enabled systemd linger for $USER (sudo)."
      else
        echo "WARN: Could not enable linger. Run: sudo loginctl enable-linger $USER" >&2
      fi
    fi
  fi

  local startup_win startup distro startup_file
  startup=""
  distro="${WSL_DISTRO_NAME:-Ubuntu}"
  if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    startup_win="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("Startup")' | tr -d '\r')"
    if [[ -n "$startup_win" ]]; then
      startup="$(wslpath -u "$startup_win" 2>/dev/null || true)"
    fi
  fi

  if [[ -n "$startup" && -d "$startup" ]]; then
    startup_file="$startup/VibeReadingPrivateBlog-$(path_id).cmd"
    # Remove the pre-template installer hook when upgrading an existing setup.
    if [[ -f "$startup/VibeReadingPrivateBlog.cmd" ]]; then
      rm -f "$startup/VibeReadingPrivateBlog.cmd"
    fi
    cat > "$startup_file" <<EOF
@echo off
wsl.exe -d "${distro}" --user "${USER}" -e bash -lc "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do systemctl --user start '${SYSTEMD_UNIT}' && exit 0; sleep 2; done"
EOF
    echo "Installed Windows startup hook: $startup_file"
  else
    echo "WARN: Windows Startup folder not found; WSL linger will start the blog when the distro boots." >&2
  fi
}

remove_wsl_startup() {
  is_wsl || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  command -v wslpath >/dev/null 2>&1 || return 0

  local startup_win startup startup_file
  startup_win="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("Startup")' | tr -d '\r')"
  startup="$(wslpath -u "$startup_win" 2>/dev/null || true)"
  startup_file="$startup/VibeReadingPrivateBlog-$(path_id).cmd"
  if [[ -f "$startup_file" ]]; then
    rm -f "$startup_file"
    echo "Removed Windows startup hook: $startup_file"
  fi
}

systemd_setup() {
  require_command systemctl
  require_command systemd-escape
  SYSTEMD_INSTANCE="$(systemd-escape --path "$ROOT")"
  SYSTEMD_UNIT="vibe-reading-private@${SYSTEMD_INSTANCE}.service"
  SYSTEMD_SOURCE="$ROOT/scripts/systemd/vibe-reading-private@.service"
  SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SYSTEMD_DEST="$SYSTEMD_DIR/vibe-reading-private@.service"
}

systemd_install() {
  mkdir -p "$SYSTEMD_DIR"
  # Migrate the original fixed-name, hard-coded unit before starting the new
  # path-aware instance; leaving both enabled would make them fight for 4321.
  if [[ -f "$SYSTEMD_DIR/vibe-reading-private.service" ]]; then
    systemctl --user disable --now vibe-reading-private.service 2>/dev/null || true
    rm -f "$SYSTEMD_DIR/vibe-reading-private.service"
  fi
  cp "$SYSTEMD_SOURCE" "$SYSTEMD_DEST"
  chmod +x "$ROOT/scripts/local-blog.sh" "$ROOT/scripts/local-blog-ctl.sh"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SYSTEMD_UNIT"
  install_wsl_startup
  echo "Installed: $SYSTEMD_UNIT"
  systemd_status
}

systemd_start() {
  [[ -f "$SYSTEMD_DEST" ]] || die "Service is not installed. Run: bash scripts/local-blog-ctl.sh install"
  systemctl --user enable --now "$SYSTEMD_UNIT"
}

systemd_stop() {
  systemctl --user disable --now "$SYSTEMD_UNIT" 2>/dev/null || true
  echo "Stopped and disabled: $SYSTEMD_UNIT"
}

systemd_restart() {
  [[ -f "$SYSTEMD_DEST" ]] || die "Service is not installed. Run: bash scripts/local-blog-ctl.sh install"
  systemctl --user enable "$SYSTEMD_UNIT" >/dev/null
  systemctl --user restart "$SYSTEMD_UNIT"
}

systemd_status() {
  systemctl --user --no-pager --full status "$SYSTEMD_UNIT" || true
  http_status
}

systemd_logs() {
  require_command journalctl
  exec journalctl --user -u "$SYSTEMD_UNIT" -f
}

systemd_uninstall() {
  systemctl --user disable --now "$SYSTEMD_UNIT" 2>/dev/null || true
  remove_wsl_startup
  # Keep the shared template: another checkout may use a different instance.
  systemctl --user daemon-reload
  echo "Uninstalled instance: $SYSTEMD_UNIT"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

launchd_setup() {
  require_command launchctl
  LAUNCHD_LABEL="io.github.dragonliu2018.vibe-reading-private.$(path_id)"
  LAUNCHD_DOMAIN="gui/$(id -u)"
  LAUNCHD_TARGET="$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
  LAUNCHD_DIR="$HOME/Library/LaunchAgents"
  LAUNCHD_PLIST="$LAUNCHD_DIR/$LAUNCHD_LABEL.plist"
  LAUNCHD_LOG_DIR="$HOME/Library/Logs/VibeReading"
  LAUNCHD_STDOUT="$LAUNCHD_LOG_DIR/private-blog-$(path_id).log"
  LAUNCHD_STDERR="$LAUNCHD_LOG_DIR/private-blog-$(path_id).error.log"
}

write_launchd_plist() {
  local label_xml root_xml script_xml stdout_xml stderr_xml path_xml
  label_xml="$(xml_escape "$LAUNCHD_LABEL")"
  root_xml="$(xml_escape "$ROOT")"
  script_xml="$(xml_escape "$ROOT/scripts/local-blog.sh")"
  stdout_xml="$(xml_escape "$LAUNCHD_STDOUT")"
  stderr_xml="$(xml_escape "$LAUNCHD_STDERR")"
  path_xml="$(xml_escape "$PATH")"

  cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$script_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONTENT_MODE</key>
    <string>private</string>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$stdout_xml</string>
  <key>StandardErrorPath</key>
  <string>$stderr_xml</string>
</dict>
</plist>
EOF
}

launchd_install() {
  mkdir -p "$LAUNCHD_DIR" "$LAUNCHD_LOG_DIR"
  chmod +x "$ROOT/scripts/local-blog.sh" "$ROOT/scripts/local-blog-ctl.sh"
  launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
  write_launchd_plist
  chmod 600 "$LAUNCHD_PLIST"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$LAUNCHD_PLIST" >/dev/null
  fi
  launchctl enable "$LAUNCHD_TARGET"
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST"
  echo "Installed LaunchAgent: $LAUNCHD_LABEL"
  launchd_status
}

launchd_start() {
  [[ -f "$LAUNCHD_PLIST" ]] || die "LaunchAgent is not installed. Run: bash scripts/local-blog-ctl.sh install"
  launchctl enable "$LAUNCHD_TARGET"
  if ! launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST"
  fi
  launchctl kickstart "$LAUNCHD_TARGET"
}

launchd_stop() {
  launchctl disable "$LAUNCHD_TARGET" 2>/dev/null || true
  launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
  echo "Stopped and disabled: $LAUNCHD_LABEL"
}

launchd_restart() {
  [[ -f "$LAUNCHD_PLIST" ]] || die "LaunchAgent is not installed. Run: bash scripts/local-blog-ctl.sh install"
  launchctl enable "$LAUNCHD_TARGET"
  if launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
    launchctl kickstart -k "$LAUNCHD_TARGET"
  else
    launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST"
  fi
}

launchd_status() {
  launchctl print "$LAUNCHD_TARGET" 2>/dev/null || echo "LaunchAgent is not loaded: $LAUNCHD_LABEL"
  http_status
}

launchd_logs() {
  mkdir -p "$LAUNCHD_LOG_DIR"
  touch "$LAUNCHD_STDOUT" "$LAUNCHD_STDERR"
  exec tail -n 100 -F "$LAUNCHD_STDOUT" "$LAUNCHD_STDERR"
}

launchd_uninstall() {
  launchctl disable "$LAUNCHD_TARGET" 2>/dev/null || true
  launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
  if [[ -f "$LAUNCHD_PLIST" ]]; then
    rm -f "$LAUNCHD_PLIST"
  fi
  echo "Uninstalled LaunchAgent: $LAUNCHD_LABEL"
}

if [[ "$HELP_ONLY" == "1" ]]; then
  usage
  exit 0
fi

case "$PLATFORM" in
  Linux) systemd_setup; BACKEND=systemd ;;
  Darwin) launchd_setup; BACKEND=launchd ;;
  *) die "Unsupported operating system: $PLATFORM (supported: Linux/WSL and macOS)." ;;
esac

case "$ACTION" in
  install|start|stop|restart|status|logs|uninstall)
    "${BACKEND}_${ACTION}"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
