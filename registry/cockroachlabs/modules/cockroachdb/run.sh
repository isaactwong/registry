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
# Set by the Coder agent; on PATH for every workspace session.
: "${CODER_SCRIPT_BIN_DIR:=$HOME/.local/bin}"

[[ -n "$STORE_PATH" ]] || STORE_PATH="$HOME/.crdb-data"
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
    for tool in curl tar sha256sum; do
      command -v "$tool" > /dev/null || {
        echo "Missing required tool: $tool" >&2
        exit 1
      }
    done

    TARBALL="cockroach-${CRDB_VERSION}.linux-${ARCH}.tgz"
    URL="${BINARY_URL%/}/${TARBALL}"
    echo "Downloading $URL..."
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT

    curl -fsSL -o "$WORK/$TARBALL" "$URL" || {
      echo "Could not download $URL. On restricted networks, set binary_url to an internal mirror or bake cockroach into the image." >&2
      exit 1
    }
    curl -fsSL -o "$WORK/$TARBALL.sha256sum" "$URL.sha256sum"
    (cd "$WORK" && sha256sum -c "$TARBALL.sha256sum")

    mkdir -p "$(dirname "$BINARY_PATH")"
    tar -xzf "$WORK/$TARBALL" -C "$(dirname "$BINARY_PATH")" --strip-components=1 \
      "cockroach-${CRDB_VERSION}.linux-${ARCH}/cockroach"
  fi

  ln -sf "$BINARY_PATH" "$BIN_DIR/cockroach"
fi

# --- crdb-start helper ----------------------------------------------------
cat > "$BIN_DIR/crdb-start" << EOF
#!/usr/bin/env bash
set -euo pipefail
PID_FILE="$PID_FILE"
if [[ -f "\$PID_FILE" ]] && kill -0 "\$(cat "\$PID_FILE")" 2> /dev/null; then
  echo "CockroachDB already running (PID \$(cat "\$PID_FILE"))."
  exit 0
fi
rm -f "\$PID_FILE"
mkdir -p "$STORE_PATH"
echo "Starting CockroachDB..."
# No diagnostics reporting: workspaces may sit inside a no-egress perimeter.
COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING=true nohup "$BINARY_PATH" start-single-node \\
  --insecure \\
  --store="$STORE_PATH" \\
  --listen-addr="localhost:$SQL_PORT" \\
  --http-addr="localhost:$HTTP_PORT" \\
  --pid-file="\$PID_FILE" \\
  >> "$LOG_FILE" 2>&1 &
TIMEOUT="\${READY_TIMEOUT:-$READY_TIMEOUT}"
for _ in \$(seq 1 "\$TIMEOUT"); do
  if curl -fsS "http://localhost:$HTTP_PORT/health?ready=1" > /dev/null 2>&1; then
    echo "CockroachDB ready: SQL localhost:$SQL_PORT | Console http://localhost:$HTTP_PORT"
    exit 0
  fi
  sleep 1
done
echo "CockroachDB not ready after \${TIMEOUT}s. Last log lines:" >&2
tail -n 20 "$LOG_FILE" >&2 || true
echo "Full log: $LOG_FILE" >&2
exit 1
EOF
chmod +x "$BIN_DIR/crdb-start"

# --- crdb-reset helper ----------------------------------------------------
cat > "$BIN_DIR/crdb-reset" << EOF
#!/usr/bin/env bash
set -euo pipefail
PID_FILE="$PID_FILE"
STORE_PATH="$STORE_PATH"
case "\$STORE_PATH" in
  "" | "/" | "\$HOME" | "\$HOME/")
    echo "Refusing to wipe store path '\$STORE_PATH'." >&2
    exit 1
    ;;
esac
if [[ -f "\$PID_FILE" ]] && kill -0 "\$(cat "\$PID_FILE")" 2> /dev/null; then
  PID="\$(cat "\$PID_FILE")"
  echo "Stopping CockroachDB (PID \$PID)..."
  kill "\$PID"
  for _ in \$(seq 1 30); do
    kill -0 "\$PID" 2> /dev/null || break
    sleep 1
  done
  if kill -0 "\$PID" 2> /dev/null; then
    echo "CockroachDB did not stop within 30s; aborting reset." >&2
    exit 1
  fi
fi
rm -f "\$PID_FILE"
rm -rf -- "\$STORE_PATH"
echo "Store at \$STORE_PATH wiped. Starting a fresh cluster..."
exec "$BIN_DIR/crdb-start"
EOF
chmod +x "$BIN_DIR/crdb-reset"

# --- Start ----------------------------------------------------------------
exec "$BIN_DIR/crdb-start"
