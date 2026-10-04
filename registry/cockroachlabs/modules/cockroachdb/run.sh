#!/usr/bin/env bash
set -euo pipefail

# Set by the coder_script prelude (see main.tf). Defaults allow standalone runs.
: "${CRDB_VERSION:?CRDB_VERSION must be set}"
: "${STORE_PATH:=}"
: "${SQL_PORT:=26257}"
: "${HTTP_PORT:=26080}"
: "${BINARY_URL:=https://binaries.cockroachdb.com}"
: "${READY_TIMEOUT:=60}"
: "${NET_SYS_DIR:=/sys/class/net}"
: "${LIBC_PROBE_DIR:=/lib}"
# Set by the Coder agent; on PATH for every workspace session.
: "${CODER_SCRIPT_BIN_DIR:=$HOME/.local/bin}"

[[ -n "$STORE_PATH" ]] || STORE_PATH="$HOME/.crdb-data"
if [[ "$STORE_PATH" != /* ]]; then
  echo "store_path must be an absolute path, got '$STORE_PATH'." >&2
  exit 1
fi
BIN_DIR="$CODER_SCRIPT_BIN_DIR"
STATE_DIR="$HOME/.local/share/cockroachdb"
PID_FILE="$STATE_DIR/crdb.pid"
LOG_FILE="$STATE_DIR/crdb.log"

# --- Platform detection ---------------------------------------------------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Unsupported OS: $(uname -s). This module supports Linux workspace agents only." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "Unsupported arch: $(uname -m). See https://www.cockroachlabs.com/docs/stable/install-cockroachdb for manual install." >&2
    exit 1
    ;;
esac

# curl is needed for the readiness check even when cockroach is preinstalled.
command -v curl > /dev/null || {
  echo "Missing required tool: curl" >&2
  exit 1
}

mkdir -p "$STATE_DIR" "$BIN_DIR" "$STORE_PATH"

# --- Shared-network check (best effort, warn only) ------------------------
# Insecure mode is safe only if localhost is private to this workspace. Host
# container interfaces (docker0, veth*, CNI) suggest host networking on a
# shared machine. A VM workspace running Docker also matches, so only warn.
if compgen -G "$NET_SYS_DIR/docker0" > /dev/null \
  || compgen -G "$NET_SYS_DIR/veth*" > /dev/null \
  || compgen -G "$NET_SYS_DIR/cni*" > /dev/null \
  || compgen -G "$NET_SYS_DIR/cali*" > /dev/null; then
  echo "WARNING: this workspace may share its host's network (container interfaces found in $NET_SYS_DIR)." >&2
  echo "CockroachDB runs without a password. On a machine shared by several developers, others may reach localhost:$SQL_PORT." >&2
  echo "Do not use this module with host-networked templates on shared machines." >&2
fi

# --- Binary resolution ----------------------------------------------------
# 1. A cockroach baked into the image wins (restricted networks).
# 2. Otherwise download the pinned version from BINARY_URL.
PREINSTALLED="$(command -v cockroach 2> /dev/null || true)"
if [[ -n "$PREINSTALLED" && "$PREINSTALLED" != "$BIN_DIR/cockroach" ]]; then
  BINARY_PATH="$PREINSTALLED"
  echo "Using preinstalled cockroach at $BINARY_PATH (crdb_version is ignored)."
  "$BINARY_PATH" version 2> /dev/null | head -n 1 || true
else
  echo "Using CockroachDB $CRDB_VERSION on linux-$ARCH"
  BINARY_PATH="$STATE_DIR/$CRDB_VERSION/cockroach"

  if [[ ! -x "$BINARY_PATH" ]]; then
    for tool in tar sha256sum; do
      command -v "$tool" > /dev/null || {
        echo "Missing required tool: $tool" >&2
        exit 1
      }
    done

    # CockroachDB's Linux binaries are linked against glibc.
    LDD_OUT="$(ldd --version 2>&1 || true)"
    if compgen -G "$LIBC_PROBE_DIR/ld-musl-*" > /dev/null || [[ "$LDD_OUT" == *musl* ]]; then
      echo "This system uses musl libc (for example Alpine), and CockroachDB's Linux binaries need glibc. Use a glibc-based image such as Debian, Ubuntu, or UBI, or bake a compatible cockroach into the image." >&2
      exit 1
    fi

    PREFIX="cockroach-${CRDB_VERSION}.linux-${ARCH}"
    TARBALL="${PREFIX}.tgz"
    URL="${BINARY_URL%/}/${TARBALL}"
    echo "Downloading $URL..."
    WORK="$(mktemp -d)" || {
      echo "Could not create a temporary directory. Check free disk space in ${TMPDIR:-/tmp}, then re-run." >&2
      exit 1
    }
    trap 'rm -rf "$WORK"' EXIT

    curl -fsSL -o "$WORK/$TARBALL" "$URL" || {
      rc=$?
      if [[ "$rc" -eq 23 ]]; then
        echo "Could not write the download of $URL to $WORK. Check free disk space, then re-run." >&2
      else
        echo "Could not download $URL. On restricted networks, set binary_url to an internal mirror or bake cockroach into the image." >&2
      fi
      exit 1
    }
    curl -fsSL -o "$WORK/$TARBALL.sha256sum" "$URL.sha256sum" || {
      echo "Could not download $URL.sha256sum. A binary_url mirror must also serve the .sha256sum file next to the tarball." >&2
      exit 1
    }
    (cd "$WORK" && sha256sum -c "$TARBALL.sha256sum") || {
      echo "Checksum verification failed for $URL. The download may be corrupt, or the mirror may be out of date." >&2
      exit 1
    }

    # Extract into the temp dir, then copy and rename within the final
    # directory so an interrupted run never leaves a partial install. The
    # binary moves last: its presence means the install is complete.
    VERSION_DIR="$(dirname "$BINARY_PATH")"
    mkdir -p "$VERSION_DIR"
    LISTING="$(tar -tzf "$WORK/$TARBALL" 2> /dev/null || true)"
    HAS_LIB=0
    [[ "$LISTING" == *"$PREFIX/lib/"* ]] && HAS_LIB=1
    # The if/return chain is explicit because set -e is off inside "if !".
    install_files() {
      tar -xzf "$WORK/$TARBALL" -C "$WORK" --strip-components=1 "$PREFIX/cockroach" || return 1
      if [[ "$HAS_LIB" -eq 1 ]]; then
        tar -xzf "$WORK/$TARBALL" -C "$WORK" --strip-components=1 "$PREFIX/lib" || return 1
        rm -rf "$VERSION_DIR/lib.partial"
        cp -R "$WORK/lib" "$VERSION_DIR/lib.partial" || return 1
        rm -rf "${VERSION_DIR:?}/lib"
        mv "$VERSION_DIR/lib.partial" "$VERSION_DIR/lib" || return 1
      fi
      cp "$WORK/cockroach" "$BINARY_PATH.partial" || return 1
      chmod +x "$BINARY_PATH.partial" || return 1
      mv -f "$BINARY_PATH.partial" "$BINARY_PATH" || return 1
    }
    if ! install_files; then
      rm -rf "$BINARY_PATH.partial" "$VERSION_DIR/lib.partial"
      echo "Failed to extract cockroach to $BINARY_PATH. Check free disk space and permissions, then re-run." >&2
      exit 1
    fi

    # Remove other downloaded versions (v* directories only).
    for old in "$STATE_DIR"/v*; do
      [[ -d "$old" && "$old" != "$VERSION_DIR" ]] || continue
      [[ "$old" != "$STORE_PATH" && "$STORE_PATH" != "$old"/* ]] || continue
      rm -rf "$old"
    done
  fi

  ln -sf "$BINARY_PATH" "$BIN_DIR/cockroach"
fi

# --- Helper config --------------------------------------------------------
# The helpers are static scripts that read their settings from this file, so
# no value is ever spliced into script text. %q quotes each value for bash.
CONFIG_FILE="$STATE_DIR/config.env"
{
  printf '%s=%q\n' PID_FILE "$PID_FILE"
  printf '%s=%q\n' STORE_PATH "$STORE_PATH"
  printf '%s=%q\n' STATE_DIR "$STATE_DIR"
  printf '%s=%q\n' BINARY_PATH "$BINARY_PATH"
  printf '%s=%q\n' LOG_FILE "$LOG_FILE"
  printf '%s=%q\n' SQL_PORT "$SQL_PORT"
  printf '%s=%q\n' HTTP_PORT "$HTTP_PORT"
  printf '%s=%q\n' READY_TIMEOUT_DEFAULT "$READY_TIMEOUT"
  printf '%s=%q\n' BIN_DIR "$BIN_DIR"
} > "$CONFIG_FILE.tmp"
mv -f "$CONFIG_FILE.tmp" "$CONFIG_FILE"

# --- crdb-start helper ----------------------------------------------------
cat > "$BIN_DIR/crdb-start" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$HOME/.local/share/cockroachdb/config.env"
# True only if the PID is alive and its command line is a CockroachDB server,
# so a PID reused by an unrelated process is never mistaken for the database.
crdb_running() {
  local cmd
  kill -0 "$1" 2> /dev/null || return 1
  if [[ -r "/proc/$1/cmdline" ]]; then
    cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2> /dev/null || true)"
  else
    cmd="$(ps -p "$1" -o args= 2> /dev/null || true)"
  fi
  [[ "$cmd" == *start-single-node* ]]
}
if [[ -f "$PID_FILE" ]] && crdb_running "$(cat "$PID_FILE")"; then
  echo "CockroachDB already running (PID $(cat "$PID_FILE"))."
  exit 0
fi
rm -f "$PID_FILE"
mkdir -p "$STORE_PATH"
echo "Starting CockroachDB..."
# No diagnostics reporting: workspaces may sit inside a no-egress perimeter.
COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING=true nohup "$BINARY_PATH" start-single-node \
  --insecure \
  --store="$STORE_PATH" \
  --listen-addr="localhost:$SQL_PORT" \
  --http-addr="localhost:$HTTP_PORT" \
  --pid-file="$PID_FILE" \
  >> "$LOG_FILE" 2>&1 &
CHILD=$!
TIMEOUT="${READY_TIMEOUT:-$READY_TIMEOUT_DEFAULT}"
for _ in $(seq 1 "$TIMEOUT"); do
  # Sleep first so a child that dies at startup is seen before health is asked.
  sleep 1
  if ! kill -0 "$CHILD" 2> /dev/null; then
    echo "CockroachDB exited before becoming ready. Last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    echo "Full log: $LOG_FILE" >&2
    exit 1
  fi
  if curl -fsS "http://localhost:$HTTP_PORT/health?ready=1" > /dev/null 2>&1; then
    echo "CockroachDB ready: SQL localhost:$SQL_PORT | Console http://localhost:$HTTP_PORT"
    exit 0
  fi
done
echo "CockroachDB not ready after ${TIMEOUT}s. Last log lines:" >&2
tail -n 20 "$LOG_FILE" >&2 || true
echo "Full log: $LOG_FILE" >&2
exit 1
EOF
chmod +x "$BIN_DIR/crdb-start"

# --- crdb-reset helper ----------------------------------------------------
cat > "$BIN_DIR/crdb-reset" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$HOME/.local/share/cockroachdb/config.env"

refuse() {
  echo "Refusing to wipe '$STORE_PATH': $1" >&2
  exit 1
}

# --- Is this path safe to empty? ---
[[ "$STORE_PATH" == /* ]] || refuse "the store path is not absolute."
case "$STORE_PATH" in
  *//* | */./* | */../* | */. | */..)
    refuse "the store path contains '.', '..', or '//' segments."
    ;;
esac
STORE="${STORE_PATH%/}"
[[ -n "$STORE" ]] || refuse "that is the filesystem root."

# Check the path as written and, when it exists, its symlink-resolved form.
CANDIDATES=("$STORE")
if [[ -d "$STORE" ]]; then
  CANDIDATES+=("$(cd "$STORE" && pwd -P)")
fi
HOME_DIRS=("${HOME%/}")
STATE_DIRS=("${STATE_DIR%/}")
if [[ -d "$HOME" ]]; then HOME_DIRS+=("$(cd "$HOME" && pwd -P)"); fi
if [[ -d "$STATE_DIR" ]]; then STATE_DIRS+=("$(cd "$STATE_DIR" && pwd -P)"); fi
for p in "${CANDIDATES[@]}"; do
  [[ -n "$p" && "$p" != "/" ]] || refuse "that is the filesystem root."
  for h in "${HOME_DIRS[@]}"; do
    [[ "$p" != "$h" ]] || refuse "that is your home directory."
    [[ "$h" != "$p"/* ]] || refuse "it contains your home directory."
  done
  for s in "${STATE_DIRS[@]}"; do
    if [[ "$p" == "$s" || "$p" == "$s"/* || "$s" == "$p"/* ]]; then
      refuse "it overlaps the module's own state directory ($STATE_DIR)."
    fi
  done
done

# --- Is it empty or a CockroachDB store? ---
if [[ -e "$STORE" && ! -d "$STORE" ]]; then
  refuse "it is not a directory."
fi
if [[ -d "$STORE" && -n "$(find "$STORE" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  HAS_MANIFEST="$(find "$STORE" -maxdepth 1 -name 'MANIFEST-*' -print -quit)"
  HAS_POINTER="$(find "$STORE" -maxdepth 1 \( -name CURRENT -o -name 'marker.manifest.*' \) -print -quit)"
  if [[ -z "$HAS_MANIFEST" || -z "$HAS_POINTER" ]]; then
    refuse "the directory is not empty and does not look like a CockroachDB store (no MANIFEST-* file with CURRENT or marker.manifest.*). Use a dedicated directory for store_path."
  fi
fi

# True only if the PID is alive and its command line is a CockroachDB server.
crdb_running() {
  local cmd
  kill -0 "$1" 2> /dev/null || return 1
  if [[ -r "/proc/$1/cmdline" ]]; then
    cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2> /dev/null || true)"
  else
    cmd="$(ps -p "$1" -o args= 2> /dev/null || true)"
  fi
  [[ "$cmd" == *start-single-node* ]]
}
if [[ -f "$PID_FILE" ]] && crdb_running "$(cat "$PID_FILE")"; then
  PID="$(cat "$PID_FILE")"
  echo "Stopping CockroachDB (PID $PID)..."
  kill "$PID"
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2> /dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2> /dev/null; then
    echo "CockroachDB did not stop within 30s; aborting reset." >&2
    exit 1
  fi
fi
rm -f "$PID_FILE"
# Empty the directory but keep it, so a mount point still works.
if [[ -d "$STORE" ]]; then
  find "$STORE" -mindepth 1 -delete
fi
echo "Store at $STORE_PATH wiped. Starting a fresh cluster..."
exec "$BIN_DIR/crdb-start"
EOF
chmod +x "$BIN_DIR/crdb-reset"

# --- Start ----------------------------------------------------------------
# exec skips the EXIT trap, so clean up the download temp dir explicitly.
if [[ -n "${WORK:-}" ]]; then
  rm -rf "$WORK"
fi
trap - EXIT
exec "$BIN_DIR/crdb-start"
