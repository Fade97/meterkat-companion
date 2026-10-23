#!/bin/sh
# User-scoped install of the built companion bundle on Linux. No root, no shell evaluation of paths.
#   scripts/install.sh install [--autostart]   copy bundle; optionally enable the systemd user unit
#   scripts/install.sh uninstall                remove autostart and the installed bundle; state is kept
set -eu
action="${1:-install}"
bundle_source="$(dirname "$0")/../output/ai-usage.cjs"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/ai-usage/companion"
target="$target_dir/ai-usage.cjs"
node_bin="${AI_USAGE_NODE:-$(command -v node || true)}"
[ -n "$node_bin" ] || { echo "Node.js 22.13+ not found; set AI_USAGE_NODE to its absolute path." >&2; exit 1; }
case "$action" in
  install)
    [ -f "$bundle_source" ] || { echo "Build first: pnpm bundle" >&2; exit 1; }
    mkdir -p "$target_dir"; chmod 700 "$target_dir"
    cp "$bundle_source" "$target.tmp"; chmod 600 "$target.tmp"; mv "$target.tmp" "$target"
    echo "Installed $target"
    if [ "${2:-}" = "--autostart" ]; then "$node_bin" "$target" autostart install
    else echo "Next: \"$node_bin\" \"$target\" register <relay>; pair; then autostart install"; fi ;;
  uninstall)
    if [ -f "$target" ]; then "$node_bin" "$target" autostart remove; fi
    rm -f "$target"; rmdir "$target_dir" 2>/dev/null || true
    echo "Bundle removed. Companion state was kept; run revoke before deleting it manually." ;;
  *) echo "Usage: $0 install [--autostart] | uninstall" >&2; exit 2 ;;
esac
