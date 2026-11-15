#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="${REPO_ROOT}/plugins"

list_plugins() {
  for dir in "${PLUGINS_DIR}"/*/; do
    [[ -d "${dir}" && -f "${dir}/install.sh" ]] || continue
    basename "${dir%/}"
  done
}

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [<plugin-name>|--all] [plugin-install-options...]

Install or uninstall Antigravity extensions from plugins/.

Examples:
  ./install.sh                           Install all plugins
  ./install.sh --all --copy              Copy-install all plugins
  ./install.sh context-usage             Install only plugins/context-usage
  ./install.sh context-usage --uninstall Uninstall only plugins/context-usage
  ./install.sh --uninstall               Uninstall all plugins

Available plugins:
EOF
  list_plugins | sed 's/^/  - /'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 && "${1}" == "--all" ]]; then
  shift
  for name in $(list_plugins); do
    echo "==> Installing plugin: ${name}"
    bash "${PLUGINS_DIR}/${name}/install.sh" "$@"
  done
  exit 0
fi

if [[ $# -gt 0 && "${1}" != -* ]]; then
  TARGET="${1}"
  shift
  SCRIPT="${PLUGINS_DIR}/${TARGET}/install.sh"
  if [[ ! -f "${SCRIPT}" ]]; then
    echo "Unknown plugin: ${TARGET}" >&2
    echo "Available plugins:" >&2
    list_plugins | sed 's/^/  - /' >&2
    exit 1
  fi
  exec bash "${SCRIPT}" "$@"
fi

FOUND="false"
for name in $(list_plugins); do
  FOUND="true"
  echo "==> Running installer for plugin: ${name}"
  bash "${PLUGINS_DIR}/${name}/install.sh" "$@"
done

if [[ "${FOUND}" != "true" ]]; then
  echo "No installable plugins found under ${PLUGINS_DIR}" >&2
  exit 1
fi
