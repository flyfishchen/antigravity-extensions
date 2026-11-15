#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="prompt-suggestion"

PLUGINS_DIR="${HOME}/.gemini/config/plugins"
TARGET_PLUGIN_DIR="${PLUGINS_DIR}/${PLUGIN_NAME}"
CLI_DIR="${HOME}/.gemini/antigravity-cli"
SETTINGS_FILE="${CLI_DIR}/settings.json"
UPSTREAM_FILE="${CLI_DIR}/prompt-suggestion-upstream.json"
STATUSLINE_CMD="~/.gemini/config/plugins/${PLUGIN_NAME}/bin/statusline.mjs"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_SUGGEST_LINK="${LOCAL_BIN_DIR}/agy-suggest"

MODE="symlink"
STATUSLINE_ONLY="false"
NO_STATUSLINE="false"
UNINSTALL="false"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install and configure the Antigravity Prompt Suggestion plugin for
Antigravity CLI (agy), Antigravity App, and Antigravity IDE.

Options:
  --copy             Copy plugin files instead of creating a symlink
  --statusline-only  Only configure statusLine in ~/.gemini/antigravity-cli/settings.json
  --no-statusline    Install plugin without modifying ~/.gemini/antigravity-cli/settings.json
  --uninstall        Remove installed plugin, agy-suggest symlink, and restore prior statusLine
  -h, --help         Show this help
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
    --no-statusline)
      NO_STATUSLINE="true"
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
  SETTINGS_PATH="${SETTINGS_FILE}" UPSTREAM_PATH="${UPSTREAM_FILE}" STATUSLINE_CMD="${STATUSLINE_CMD}" node -e '
    const fs = require("node:fs");
    const settingsPath = process.env.SETTINGS_PATH;
    const upstreamPath = process.env.UPSTREAM_PATH;
    const cmd = process.env.STATUSLINE_CMD;
    let data = {};
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw) data = JSON.parse(raw);
    }
    const prev = data.statusLine;
    if (prev && typeof prev === "object" && typeof prev.command === "string" && prev.command.trim() && !prev.command.includes("prompt-suggestion/bin/statusline")) {
      fs.writeFileSync(upstreamPath, JSON.stringify(prev, null, 2) + "\n", "utf8");
    }
    data.statusLine = {
      type: "command",
      command: cmd,
      enabled: true,
      padding: 0,
      stack_with_default: true
    };
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  '
  echo "Configured statusLine in ${SETTINGS_FILE}"
}

remove_statusline() {
  if [[ -f "${SETTINGS_FILE}" ]]; then
    cp "${SETTINGS_FILE}" "${SETTINGS_FILE}.bak"
    SETTINGS_PATH="${SETTINGS_FILE}" UPSTREAM_PATH="${UPSTREAM_FILE}" node -e '
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const settingsPath = process.env.SETTINGS_PATH;
      const upstreamPath = process.env.UPSTREAM_PATH;
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (!raw) process.exit(0);
      const data = JSON.parse(raw);
      if (data.statusLine && String(data.statusLine.command || "").includes("prompt-suggestion/bin/statusline")) {
        let restored = false;
        if (fs.existsSync(upstreamPath)) {
          try {
            const upstream = JSON.parse(fs.readFileSync(upstreamPath, "utf8"));
            if (upstream && typeof upstream.command === "string" && upstream.command.trim()) {
              const home = process.env.HOME || os.homedir();
              const expand = (s) => (s.startsWith("~/") ? path.join(home, s.slice(2)) : s);
              const rawCmd = upstream.command.trim();
              const firstTok = expand(rawCmd.split(/\s+/)[0]);
              const fullExpanded = expand(rawCmd);
              if (fs.existsSync(fullExpanded) || fs.existsSync(firstTok)) {
                data.statusLine = upstream;
                restored = true;
                console.log("Restored previous statusLine entry in " + settingsPath);
              }
            }
          } catch {
            // Ignore malformed upstream file and delete statusLine below.
          }
        }
        if (!restored) {
          delete data.statusLine;
          console.log("Removed statusLine entry from " + settingsPath);
        }
        fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      }
    '
  fi
  if [[ -f "${UPSTREAM_FILE}" ]]; then
    rm -f "${UPSTREAM_FILE}"
  fi
}

if [[ "${UNINSTALL}" == "true" ]]; then
  if [[ -L "${TARGET_PLUGIN_DIR}" || -e "${TARGET_PLUGIN_DIR}" ]]; then
    rm -rf "${TARGET_PLUGIN_DIR}"
    echo "Removed plugin at ${TARGET_PLUGIN_DIR}"
  fi
  if [[ -L "${LOCAL_SUGGEST_LINK}" ]] && [[ "$(readlink "${LOCAL_SUGGEST_LINK}")" == *"prompt-suggestion"* ]]; then
    rm -f "${LOCAL_SUGGEST_LINK}"
    echo "Removed launcher symlink at ${LOCAL_SUGGEST_LINK}"
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
  ln -sf "${TARGET_PLUGIN_DIR}/bin/suggest" "${LOCAL_SUGGEST_LINK}"
fi

if [[ "${NO_STATUSLINE}" != "true" ]]; then
  configure_statusline
fi

echo ""
echo "Installation complete!"
echo "  - Antigravity App/IDE: Sidecar UI 'Prompt Suggestions' is auto-discovered from ${TARGET_PLUGIN_DIR}"
if [[ "${NO_STATUSLINE}" != "true" ]]; then
  echo "  - Antigravity CLI statusLine: configured in ${SETTINGS_FILE} (chaining prior statusLine if present)"
fi
echo "  - CLI shortcuts: ':s' (accept #1), ':s 2' (accept #2), ':s + <note>', ':s ?', ':s clear', ':s off/on'"
echo "  - CLI boxed inspector: run 'agy-suggest' in any terminal"
