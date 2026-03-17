#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="${ROOT_DIR}/release"
MANIFEST_PATH="${ROOT_DIR}/manifest.json"
XPI_NAME='ZotANLP.xpi'

REPO_SLUG="${GITHUB_REPOSITORY:-adno/zot-anlp}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL:-https://github.com/${REPO_SLUG}/releases/latest/download}"
UPDATE_LINK="${UPDATE_LINK:-${DOWNLOAD_BASE_URL}/${XPI_NAME}}"
UPDATE_INFO_URL="${UPDATE_INFO_URL:-https://github.com/${REPO_SLUG}/releases/latest}"

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "manifest.json not found at ${MANIFEST_PATH}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo 'node is required to read manifest.json' >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo 'zip is required to build the .xpi package' >&2
  exit 1
fi

VERSION="$(node -p "require('${MANIFEST_PATH}').version")"
ADDON_ID="$(node -p "require('${MANIFEST_PATH}').applications.zotero.id")"
STRICT_MIN_VERSION="$(node -p "require('${MANIFEST_PATH}').applications.zotero.strict_min_version")"
STRICT_MAX_VERSION="$(node -p "require('${MANIFEST_PATH}').applications.zotero.strict_max_version")"

mkdir -p "$RELEASE_DIR"
rm -f "${RELEASE_DIR}/${XPI_NAME}" "${RELEASE_DIR}/updates.json"

(
  cd "$ROOT_DIR"
  zip -qr "${RELEASE_DIR}/${XPI_NAME}" manifest.json bootstrap.js prefs.xhtml src README.md LICENSE
)

cat > "${RELEASE_DIR}/updates.json" <<EOF
{
  "addons": {
    "${ADDON_ID}": {
      "updates": [
        {
          "version": "${VERSION}",
          "update_link": "${UPDATE_LINK}",
          "update_info_url": "${UPDATE_INFO_URL}",
          "applications": {
            "zotero": {
              "strict_min_version": "${STRICT_MIN_VERSION}",
              "strict_max_version": "${STRICT_MAX_VERSION}"
            }
          }
        }
      ]
    }
  }
}
EOF

echo "Built ${RELEASE_DIR}/${XPI_NAME}"
echo "Built ${RELEASE_DIR}/updates.json"
