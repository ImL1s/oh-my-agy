#!/usr/bin/env bash
# OMA installer: standalone verified GitHub bootstrap, zero-network offline asset,
# or explicit local-development build. Release bytes are verified before use.
set -euo pipefail
umask 077

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  # Standalone / no checkout: resolve or pin an exact GitHub release.
  bash install.sh [--github] [--tag vX.Y.Z]

  # Manual/offline: performs no network or dependency/build steps.
  bash install.sh --asset ./iml1s-oh-my-agy-X.Y.Z.tgz --checksums ./SHA256SUMS
  bash install.sh --asset ./iml1s-oh-my-agy-X.Y.Z.tgz --asset-sha256 <sha256>

  # Checkout-only developer path (the only mode allowed to run npm/build).
  bash scripts/install.sh --local-dev [checkout]

Options:
  --asset-url URL       Exact release asset URL (HTTPS only).
  --checksums-url URL   Exact SHA256SUMS URL (HTTPS only).
  --source-uri URI      Receipt source override for an offline asset.
  --with-auxiliary      Also install Claude/Grok namespaced slash surfaces.
  --no-auxiliary        Skip auxiliary surfaces (offline default).
EOF
}

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
CHECKOUT_ROOT=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  MAYBE_ROOT="$(cd "$(dirname "$SCRIPT_SOURCE")/.." 2>/dev/null && pwd || true)"
  if [[ -n "$MAYBE_ROOT" && -f "$MAYBE_ROOT/package.json" \
    && -f "$MAYBE_ROOT/src/setup/update.ts" ]]; then
    CHECKOUT_ROOT="$MAYBE_ROOT"
  fi
fi

MODE=""
ASSET=""
CHECKSUMS=""
EXPECTED_ASSET_SHA=""
RELEASE_TAG="${OMA_RELEASE_TAG:-}"
ASSET_URL=""
CHECKSUMS_URL=""
SOURCE_URI="${OMA_SOURCE_URI:-}"
LOCAL_ROOT=""
NO_AUXILIARY=-1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --github)
      [[ -z "$MODE" || "$MODE" == "github" ]] || die '--github cannot be combined with another mode'
      MODE="github"; shift ;;
    --tag)
      [[ $# -ge 2 ]] || die '--tag requires vX.Y.Z'
      RELEASE_TAG="$2"; shift 2 ;;
    --asset-url)
      [[ $# -ge 2 ]] || die '--asset-url requires HTTPS URL'
      ASSET_URL="$2"; shift 2 ;;
    --checksums-url)
      [[ $# -ge 2 ]] || die '--checksums-url requires HTTPS URL'
      CHECKSUMS_URL="$2"; shift 2 ;;
    --asset)
      [[ $# -ge 2 ]] || die '--asset requires a path'
      [[ -z "$MODE" || "$MODE" == "offline" ]] || die '--asset cannot be combined with another mode'
      MODE="offline"; ASSET="$2"; shift 2 ;;
    --checksums)
      [[ $# -ge 2 ]] || die '--checksums requires SHA256SUMS'
      CHECKSUMS="$2"; shift 2 ;;
    --asset-sha256)
      [[ $# -ge 2 ]] || die '--asset-sha256 requires a digest'
      EXPECTED_ASSET_SHA="$2"; shift 2 ;;
    --source-uri)
      [[ $# -ge 2 ]] || die '--source-uri requires a URI'
      SOURCE_URI="$2"; shift 2 ;;
    --local-dev)
      [[ -z "$MODE" || "$MODE" == "local-dev" ]] || die '--local-dev cannot be combined with another mode'
      MODE="local-dev"
      if [[ $# -ge 2 && "$2" != --* ]]; then LOCAL_ROOT="$2"; shift 2; else shift; fi ;;
    --with-auxiliary)
      NO_AUXILIARY=0; shift ;;
    --no-auxiliary)
      NO_AUXILIARY=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  if [[ -n "$CHECKOUT_ROOT" ]]; then MODE="local-dev"; LOCAL_ROOT="$CHECKOUT_ROOT"; else MODE="github"; fi
fi
if [[ -n "$RELEASE_TAG" && "$MODE" == "" ]]; then MODE="github"; fi
if [[ "$MODE" == "github" && -n "$ASSET" ]]; then die 'GitHub mode cannot accept --asset'; fi
if [[ "$MODE" == "offline" && ( -n "$ASSET_URL" || -n "$CHECKSUMS_URL" ) ]]; then
  die 'offline mode rejects network URL options'
fi
if [[ "$MODE" == "offline" && -z "$CHECKSUMS" && -z "$EXPECTED_ASSET_SHA" ]]; then
  printf 'error: offline archive requires --checksums or --asset-sha256\n' >&2
  exit 2
fi
if [[ "$MODE" == "offline" && "$NO_AUXILIARY" -lt 0 ]]; then NO_AUXILIARY=1; fi
if [[ "$NO_AUXILIARY" -lt 0 ]]; then NO_AUXILIARY=0; fi

command -v node >/dev/null 2>&1 || die 'node not found (need >=20)'
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 20 ]] || die "Node $NODE_MAJOR < 20"

WORK_ROOT=""
cleanup() {
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    chmod -R u+rwX "$WORK_ROOT" 2>/dev/null || true
    rm -rf "$WORK_ROOT"
  fi
}
trap cleanup EXIT HUP INT TERM

new_work_root() {
  local parent="${TMPDIR:-/tmp}"
  WORK_ROOT="$(mktemp -d "$parent/oma-install.XXXXXXXX")"
  chmod 700 "$WORK_ROOT"
  [[ ! -L "$WORK_ROOT" && "$(directory_mode "$WORK_ROOT")" == "700" ]] \
    || die 'installer temp root is not a real 0700 directory'
}

directory_mode() {
  local mode
  if mode="$(stat -c '%a' "$1" 2>/dev/null)" && [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s' "$mode"
    return 0
  fi
  if mode="$(stat -f '%Lp' "$1" 2>/dev/null)" && [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s' "$mode"
    return 0
  fi
  return 1
}

sha256_file() {
  local output digest
  [[ -f "$1" && ! -L "$1" ]] || die "asset is not a regular non-symlink file: $1"
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$1")"
  elif command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$1")"
  else
    die 'sha256sum or shasum is required'
  fi
  digest="${output%%[[:space:]]*}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die 'SHA-256 tool returned malformed output'
  printf '%s' "$digest"
}

verify_asset() {
  local asset="$1" manifest="$2" explicit="$3" actual line rows expected file_name
  actual="$(sha256_file "$asset")"
  if [[ -n "$manifest" ]]; then
    [[ -f "$manifest" && ! -L "$manifest" ]] || die 'SHA256SUMS must be a regular non-symlink file'
    rows=0
    expected=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      if [[ "$line" =~ ^([0-9a-f]{64})[[:space:]]+\*?(.+)$ ]]; then
        file_name="${BASH_REMATCH[2]}"
        [[ "$file_name" == ./* ]] && file_name="${file_name#./}"
        if [[ "$file_name" == "$(basename "$asset")" ]]; then
          rows=$((rows + 1)); expected="${BASH_REMATCH[1]}"
        fi
      else
        die 'SHA256SUMS contains a malformed row'
      fi
    done < "$manifest"
    [[ "$rows" -eq 1 ]] || die 'SHA256SUMS must contain exactly one row for the asset'
    [[ "$actual" == "$expected" ]] || die 'release asset checksum mismatch'
  fi
  if [[ -n "$explicit" ]]; then
    [[ "$explicit" =~ ^[0-9a-f]{64}$ ]] || die '--asset-sha256 is malformed'
    [[ "$actual" == "$explicit" ]] || die 'release asset does not match --asset-sha256'
  fi
  printf '%s' "$actual"
}

download() {
  local url="$1" target="$2"
  [[ "$url" == https://* ]] || die 'release downloads require HTTPS URLs'
  command -v curl >/dev/null 2>&1 || die 'curl is required for GitHub bootstrap mode'
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --output "$target" "$url"
  chmod 600 "$target"
  [[ -f "$target" && ! -L "$target" ]] || die 'download did not produce a regular file'
}

extract_verified_archive() {
  local archive="$1" extraction="$2" entry verbose line kind package_root
  command -v tar >/dev/null 2>&1 || die 'tar is required'
  entry="$(tar -tzf "$archive")" || die 'release archive listing failed'
  [[ -n "$entry" ]] || die 'release archive is empty'
  while IFS= read -r line; do
    line="${line%/}"
    [[ -n "$line" && "$line" != /* && "$line" != *\\* ]] || die 'release archive has an unsafe path'
    case "/$line/" in */../*|*/./*) die 'release archive has traversal or non-canonical paths' ;; esac
  done <<< "$entry"
  verbose="$(tar -tvzf "$archive")" || die 'release archive type listing failed'
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    kind="${line:0:1}"
    [[ "$kind" == '-' || "$kind" == 'd' ]] || die 'release archive contains links or special files'
  done <<< "$verbose"
  mkdir -p "$extraction"
  chmod 700 "$extraction"
  tar -xzf "$archive" -C "$extraction" || die 'release archive extraction failed'
  package_root="$(node - "$extraction" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = fs.realpathSync(process.argv[2]);
const packages = [];
function visit(current) {
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('unsafe extracted entry');
    }
    if (stat.isDirectory()) visit(absolute);
  }
  const manifest = path.join(current, 'package.json');
  if (fs.existsSync(manifest) && fs.lstatSync(manifest).isFile()) packages.push(current);
}
visit(root);
if (packages.length !== 1) throw new Error('archive must contain exactly one package root');
process.stdout.write(fs.realpathSync(packages[0]));
NODE
)" || die 'release archive post-extraction validation failed'
  local required
  for required in \
    package.json plugin.json hooks.json .claude-plugin/plugin.json \
    dist/bin/oma.js dist/src/hooks/pre-invocation.js dist/src/hooks/stop.js \
    dist/src/setup/update.js skills/autopilot/SKILL.md rules/runtime.md; do
    [[ -f "$package_root/$required" && ! -L "$package_root/$required" ]] \
      || die "verified archive is missing runnable surface: $required"
  done
  printf '%s' "$package_root"
}

echo '==> oh-my-agy immutable installer'
echo '    primary UX: /oh-my-agy:autopilot'

PACKAGE_ROOT=""
PACKAGE_DIGEST=""
ASSET_SHA=""
INSTALL_MODE="development"
ARCHIVE_VERSION=""

if [[ "$MODE" == "local-dev" ]]; then
  # LOCAL_DEV_NETWORK_BUILD_START
  LOCAL_ROOT="${LOCAL_ROOT:-$CHECKOUT_ROOT}"
  [[ -n "$LOCAL_ROOT" ]] || die '--local-dev requires a checkout path outside the repository script'
  PACKAGE_ROOT="$(cd "$LOCAL_ROOT" && pwd)"
  [[ -f "$PACKAGE_ROOT/package.json" && -f "$PACKAGE_ROOT/src/setup/update.ts" ]] \
    || die 'local development root is not an OMA checkout'
  echo '==> local-dev only: install pinned dependencies and build'
  (cd "$PACKAGE_ROOT" && { [[ -f package-lock.json ]] && npm ci || npm install; } && npm run build)
  # LOCAL_DEV_NETWORK_BUILD_END
else
  new_work_root
  if [[ "$MODE" == "github" ]]; then
    if [[ -z "$RELEASE_TAG" ]]; then
      echo '==> resolve latest GitHub release to an exact tag'
      RELEASE_JSON="$WORK_ROOT/release.json"
      download 'https://api.github.com/repos/ImL1s/oh-my-agy/releases/latest' "$RELEASE_JSON"
      RELEASE_TAG="$(node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof v.tag_name!=="string")process.exit(2);process.stdout.write(v.tag_name)' "$RELEASE_JSON")" \
        || die 'GitHub latest response has no exact tag'
    fi
    [[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
      || die 'release tag is not canonical semver'
    VERSION="${RELEASE_TAG#v}"
    ASSET_NAME="iml1s-oh-my-agy-$VERSION.tgz"
    ASSET_URL="${ASSET_URL:-https://github.com/ImL1s/oh-my-agy/releases/download/$RELEASE_TAG/$ASSET_NAME}"
    CHECKSUMS_URL="${CHECKSUMS_URL:-https://github.com/ImL1s/oh-my-agy/releases/download/$RELEASE_TAG/SHA256SUMS}"
    ASSET="$WORK_ROOT/$ASSET_NAME"
    CHECKSUMS="$WORK_ROOT/SHA256SUMS"
    echo "==> download exact release $RELEASE_TAG into 0700 staging"
    download "$ASSET_URL" "$ASSET"
    download "$CHECKSUMS_URL" "$CHECKSUMS"
    SOURCE_URI="$ASSET_URL"
  else
    ASSET="$(cd "$(dirname "$ASSET")" && pwd)/$(basename "$ASSET")"
    [[ -z "$CHECKSUMS" ]] || CHECKSUMS="$(cd "$(dirname "$CHECKSUMS")" && pwd)/$(basename "$CHECKSUMS")"
    SOURCE_URI="${SOURCE_URI:-file://$ASSET}"
  fi

  ASSET_BASENAME="$(basename "$ASSET")"
  if [[ "$ASSET_BASENAME" =~ ^iml1s-oh-my-agy-((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?)\.tgz$ ]]; then
    ARCHIVE_VERSION="${BASH_REMATCH[1]}"
  else
    die 'release asset name must be iml1s-oh-my-agy-<semver>.tgz'
  fi
  RELEASE_TAG="${RELEASE_TAG:-v$ARCHIVE_VERSION}"
  [[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
    || die 'release tag must be exact v<semver>'
  [[ "${RELEASE_TAG#v}" == "$ARCHIVE_VERSION" ]] \
    || die 'release tag version does not match archive asset name'

  echo '==> verify release checksum before extracting or executing candidate bytes'
  ASSET_SHA="$(verify_asset "$ASSET" "$CHECKSUMS" "$EXPECTED_ASSET_SHA")"
  SEALED_ASSET="$WORK_ROOT/verified-$(basename "$ASSET")"
  cp "$ASSET" "$SEALED_ASSET"
  chmod 400 "$SEALED_ASSET"
  [[ "$(sha256_file "$SEALED_ASSET")" == "$ASSET_SHA" ]] \
    || die 'release asset changed while creating the verified copy'
  PACKAGE_ROOT="$(extract_verified_archive "$SEALED_ASSET" "$WORK_ROOT/extracted")"
  INSTALL_MODE="release"
fi

PREFLIGHT_ARGS=(--preflight-only --package-root "$PACKAGE_ROOT")
[[ "$INSTALL_MODE" != 'release' ]] || PREFLIGHT_ARGS+=(--release)
[[ -z "$ASSET_SHA" ]] || PREFLIGHT_ARGS+=(--asset-sha256 "$ASSET_SHA")
echo '==> candidate identity/runnable-surface preflight (no host mutation)'
PREFLIGHT_HOME="${WORK_ROOT:-$HOME}"
PREFLIGHT_STATE_ROOT="${WORK_ROOT:-${OMA_STATE_ROOT:-$HOME/.oma-preflight}}/preflight-state"
set +e
PREFLIGHT_JSON="$(HOME="$PREFLIGHT_HOME" OMA_STATE_ROOT="$PREFLIGHT_STATE_ROOT" \
  node "$PACKAGE_ROOT/dist/src/setup/update.js" "${PREFLIGHT_ARGS[@]}")"
PREFLIGHT_STATUS=$?
set -e
[[ "$PREFLIGHT_STATUS" -eq 0 ]] || die 'candidate preflight failed before host mutation'
PACKAGE_DIGEST="$(node -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||!/^([a-f0-9]{64})$/.test(v.packageDigest))process.exit(2);process.stdout.write(v.packageDigest)' "$PREFLIGHT_JSON")" \
  || die 'candidate preflight returned malformed identity'
PACKAGE_VERSION="$(node -e 'const v=JSON.parse(process.argv[1]);if(typeof v.version!=="string")process.exit(2);process.stdout.write(v.version)' "$PREFLIGHT_JSON")" \
  || die 'candidate preflight returned malformed version'
if [[ "$INSTALL_MODE" == 'release' && "$PACKAGE_VERSION" != "$ARCHIVE_VERSION" ]]; then
  die 'verified archive package version does not match asset/tag identity'
fi

BIN_DIR="${OMA_BIN_DIR:-$HOME/.local/bin}"
UPDATE_ARGS=(--package-root "$PACKAGE_ROOT" --package-digest "$PACKAGE_DIGEST" --bin-dir "$BIN_DIR")
if [[ "$INSTALL_MODE" == 'release' ]]; then
  UPDATE_ARGS+=(--release --asset-sha256 "$ASSET_SHA" --source-uri "$SOURCE_URI" --source-tag "$RELEASE_TAG")
fi

echo '==> immutable stage -> Antigravity switch -> exact doctor -> receipt'
set +e
PRIMARY_JSON="$(node "$PACKAGE_ROOT/dist/src/setup/update.js" "${UPDATE_ARGS[@]}")"
PRIMARY_STATUS=$?
set -e
[[ -z "$PRIMARY_JSON" ]] || printf '%s\n' "$PRIMARY_JSON"
case "$PRIMARY_STATUS" in
  0) ;;
  2) printf 'warn: primary install completed with development warnings\n' >&2 ;;
  *) die 'primary install failed; auxiliary success cannot mask it' ;;
esac

AUX_STATUS=0
AUX_WARNING=0
if [[ "$NO_AUXILIARY" -eq 0 ]]; then
  echo '==> Claude/Grok namespaced slash surfaces'
  for HOST in claude grok; do
    set +e
    HOST_JSON="$(node "$PACKAGE_ROOT/dist/bin/oma.js" setup --host "$HOST")"
    HOST_STATUS=$?
    set -e
    printf '%s\n' "$HOST_JSON"
    [[ "$HOST_STATUS" -eq 0 ]] || AUX_STATUS=1
    [[ "$HOST_JSON" != *'"status": "needs_manual"'* ]] || AUX_WARNING=1
  done
fi
[[ "$AUX_STATUS" -eq 0 ]] || die 'an auxiliary host install hard-failed'

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  printf "warn: add to PATH: export PATH=\"%s:\$PATH\"\n" "$BIN_DIR" >&2
  AUX_WARNING=1
fi
if [[ "$PRIMARY_STATUS" -eq 2 || "$AUX_WARNING" -eq 1 ]]; then
  printf '==> completed with warnings; receipt preserves the exact primary result\n' >&2
  exit 2
fi

echo '==> installed and exactly verified'
echo '    restart the host, then: /oh-my-agy:autopilot <goal>'
