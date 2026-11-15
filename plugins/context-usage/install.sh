#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="context-usage"

PLUGINS_DIR="${HOME}/.gemini/config/plugins"
TARGET_PLUGIN_DIR="${PLUGINS_DIR}/${PLUGIN_NAME}"
CLI_DIR="${HOME}/.gemini/antigravity-cli"
SETTINGS_FILE="${CLI_DIR}/settings.json"
STATUSLINE_CMD="~/.gemini/config/plugins/${PLUGIN_NAME}/bin/statusline.mjs"
DETAIL_STATUSLINE="false"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_CTX_LINK="${LOCAL_BIN_DIR}/agy-ctx"

MODE="symlink"
STATUSLINE_ONLY="false"
UNINSTALL="false"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install and configure the Antigravity Context Usage plugin for both
Antigravity CLI (agy) and Antigravity App.

Options:
  --copy               Copy plugin files instead of creating a symlink
  --statusline-only    Only configure statusLine in ~/.gemini/antigravity-cli/settings.json
  --detail-statusline  Use 2-line detailed statusline (bin/statusline-detail)
  --uninstall          Remove installed plugin, statusLine entry, and agy-ctx symlink
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy)
      MODE="copy"
      shift
      ;;
    --statusline-only)
      STATUSLINE_ONLY="true"
      shift
      ;;
    --detail-statusline)
      DETAIL_STATUSLINE="true"
      STATUSLINE_CMD="~/.gemini/config/plugins/${PLUGIN_NAME}/bin/statusline-detail"
      shift
      ;;
    --uninstall)
      UNINSTALL="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

configure_statusline() {
  mkdir -p "${CLI_DIR}"
  if [[ -f "${SETTINGS_FILE}" ]]; then
    cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
  fi
  SETTINGS_PATH="${SETTINGS_FILE}" UPSTREAM_PATH="${CLI_DIR}/prompt-suggestion-upstream.json" STATUSLINE_CMD="${STATUSLINE_CMD}" node -e '
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const settingsPath = process.env.SETTINGS_PATH;
    const upstreamPath = process.env.UPSTREAM_PATH;
    const cmd = process.env.STATUSLINE_CMD;
    let data = {};
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw) {
        data = JSON.parse(raw);
      }
    }
    const nextCfg = {
      type: "command",
      command: cmd,
      enabled: true,
      padding: 0,
      stack_with_default: true
    };
    const curCmd = String(data?.statusLine?.command || "").trim();
    if (curCmd.includes("prompt-suggestion/bin/statusline")) {
      const home = process.env.HOME || os.homedir();
      const firstTok = curCmd.split(/\s+/)[0];
      const expanded = firstTok.startsWith("~/") ? path.join(home, firstTok.slice(2)) : firstTok;
      if (fs.existsSync(expanded)) {
        fs.writeFileSync(upstreamPath, JSON.stringify(nextCfg, null, 2) + "\n", "utf8");
        console.log("Updated prompt-suggestion upstream statusLine in " + upstreamPath);
        process.exit(0);
      }
    }
    data.statusLine = nextCfg;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log("Configured statusLine in " + settingsPath);
  '
}

remove_statusline() {
  local upstream_file="${CLI_DIR}/prompt-suggestion-upstream.json"
  if [[ -f "${upstream_file}" ]]; then
    UPSTREAM_PATH="${upstream_file}" node -e '
      const fs = require("node:fs");
      const upstreamPath = process.env.UPSTREAM_PATH;
      try {
        const raw = fs.readFileSync(upstreamPath, "utf8").trim();
        const data = raw ? JSON.parse(raw) : null;
        if (data && String(data.command || "").includes("context-usage/bin/statusline")) {
          fs.unlinkSync(upstreamPath);
          console.log("Removed upstream statusLine entry from " + upstreamPath);
        }
      } catch {
        // Ignore malformed upstream file.
      }
    '
  fi
  if [[ ! -f "${SETTINGS_FILE}" ]]; then
    return
  fi
  cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
  SETTINGS_PATH="${SETTINGS_FILE}" STATUSLINE_CMD="${STATUSLINE_CMD}" node -e '
    const fs = require("node:fs");
    const path = process.env.SETTINGS_PATH;
    const cmd = process.env.STATUSLINE_CMD;
    const raw = fs.readFileSync(path, "utf8").trim();
    if (!raw) process.exit(0);
    const data = JSON.parse(raw);
    if (data.statusLine && String(data.statusLine.command || "").includes("context-usage/bin/statusline")) {
      delete data.statusLine;
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
      console.log("Removed statusLine entry from " + path);
    }
  '
}

if [[ "${UNINSTALL}" == "true" ]]; then
  if [[ -L "${TARGET_PLUGIN_DIR}" || -e "${TARGET_PLUGIN_DIR}" ]]; then
    rm -rf "${TARGET_PLUGIN_DIR}"
    echo "Removed plugin at ${TARGET_PLUGIN_DIR}"
  fi
  if [[ -L "${LOCAL_CTX_LINK}" ]] && [[ "$(readlink "${LOCAL_CTX_LINK}")" == *"context-usage/bin/ctx"* ]]; then
    rm -f "${LOCAL_CTX_LINK}"
    echo "Removed launcher symlink at ${LOCAL_CTX_LINK}"
  fi
  remove_statusline
  echo "Uninstall complete."
  exit 0
fi

if [[ "${STATUSLINE_ONLY}" != "true" ]]; then
  mkdir -p "${PLUGINS_DIR}"
  if [[ -L "${TARGET_PLUGIN_DIR}" || -e "${TARGET_PLUGIN_DIR}" ]]; then
    rm -rf "${TARGET_PLUGIN_DIR}"
  fi

  if [[ "${MODE}" == "copy" ]]; then
    mkdir -p "${TARGET_PLUGIN_DIR}"
    SRC_DIR="${SCRIPT_DIR}" DST_DIR="${TARGET_PLUGIN_DIR}" node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const src = process.env.SRC_DIR;
      const dst = process.env.DST_DIR;
      const skip = new Set([".git", "node_modules", ".DS_Store"]);
      fs.cpSync(src, dst, {
        recursive: true,
        filter: (p) => !skip.has(path.basename(p))
      });
    '
    chmod +x "${TARGET_PLUGIN_DIR}/bin/"* "${TARGET_PLUGIN_DIR}/hooks/"*.mjs "${TARGET_PLUGIN_DIR}/install.sh"
    echo "Copied plugin to ${TARGET_PLUGIN_DIR}"
  else
    ln -s "${SCRIPT_DIR}" "${TARGET_PLUGIN_DIR}"
    echo "Linked plugin: ${TARGET_PLUGIN_DIR} -> ${SCRIPT_DIR}"
  fi

  mkdir -p "${LOCAL_BIN_DIR}"
  ln -sf "${TARGET_PLUGIN_DIR}/bin/ctx" "${LOCAL_CTX_LINK}"
fi

configure_statusline

echo ""
echo "Installation complete!"
echo "  - Antigravity App: Sidecar UI 'Context Usage' is auto-discovered from ${TARGET_PLUGIN_DIR}"
echo "  - Antigravity CLI statusLine: configured in ${SETTINGS_FILE}"
echo "  - CLI zero-token inline panel: type ':ctx', ':ctx all', or bare '/context-usage' in agy"
echo "  - CLI boxed panel & live TUI: run '!ctx' inside agy or 'agy-ctx' in any terminal"
echo "  - 2-line detailed statusline: re-run with '--detail-statusline' or '/statusline ~/.gemini/config/plugins/context-usage/bin/statusline-detail'"
