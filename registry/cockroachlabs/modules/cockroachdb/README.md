---
display_name: CockroachDB
description: Runs a single, persistent CockroachDB process inside a Coder workspace, with env vars, CLI, and DB Console pre-wired.
icon: ../../../../.icons/cockroachdb.svg
verified: false
tags: [database, sql, cockroachdb, postgres, distributed-sql]
---

# CockroachDB

Runs a single, persistent CockroachDB process inside a Coder workspace. Built for
developers whose application already runs on CockroachDB. It gives you the same
SQL surface as production, running locally in the workspace with no external
dependencies.

```tf
module "cockroachdb" {
  source   = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version  = "1.0.0"
  agent_id = coder_agent.main.id
}
```

## What the developer gets

- CockroachDB starts in the background on workspace start.
- `DATABASE_URL`, `COCKROACH_URL`, `PGHOST`, `PGPORT`, `PGUSER`, and
  `PGDATABASE` are set in every workspace session (terminal, SSH, IDE), in any
  shell.
- The `cockroach` CLI is on `PATH`, and `COCKROACH_URL` points it at the
  database, so `cockroach sql` works with no flags, even on custom ports.
- A **CockroachDB Console** button in the Coder dashboard.
- `crdb-start` restarts the database if it was stopped.
- `crdb-reset` stops the database, wipes the store, and starts a fresh cluster.

The helper commands are linked into Coder's script bin directory. If they're
missing on a long-lived VM, restart the workspace.

> [!NOTE]
> The module needs Coder v2.30 or later, because it orders its install and
> start scripts with `coder exp sync` (through the `coder-utils` module).

The database runs in insecure mode. The SQL port listens on `127.0.0.1` only,
so it is not reachable from outside the workspace (see [Host networking](#host-networking)).

> [!WARNING]
> The DB Console has no login in this insecure dev mode. Coder proxies it
> through a `coder_app`, and the module always limits it to the workspace
> owner (and Coder site admins).

## Files in the workspace

Everything the module writes lives under
`$HOME/.coder-modules/cockroachlabs/cockroachdb/`:

- `scripts/` holds the install and start scripts, plus `crdb-start`,
  `crdb-reset`, and the `crdb-common.sh` they share.
- `logs/` holds `install.log` and `start.log` from the module scripts, and
  `cockroach.log`, the database's own output.
- `bin/<version>/` holds a downloaded `cockroach` and its `lib/` directory. The
  module keeps the active version and the one active before it, and removes
  older ones after a download, so disk use is at most two versions.
- `state/` holds `config.env` (the helpers' settings), `crdb.pid`, the
  `installed` marker (written when the install script finishes; the start
  script runs only if it exists), and `active_version` and `previous_version`,
  which the module uses to decide what to keep.
- `data/` is the default store.

`cockroach` (when the module downloads it), `crdb-start`, and `crdb-reset` are
linked into Coder's script bin directory (`CODER_SCRIPT_BIN_DIR`), which is on
`PATH`.

## Examples

### Pin a CockroachDB version

The module default is `v26.3.1`. To pin a specific version:

```tf
module "cockroachdb" {
  source       = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version      = "1.0.0"
  agent_id     = coder_agent.main.id
  crdb_version = "v26.3.0"
}
```

### Deployments without wildcard subdomains

```tf
module "cockroachdb" {
  source    = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version   = "1.0.0"
  agent_id  = coder_agent.main.id
  subdomain = false
}
```

<!-- TODO: confirm whether the DB Console works behind path-based app routing, then keep or remove this example. -->

## Persistence

Data lives at `$HOME/.coder-modules/cockroachlabs/cockroachdb/data` by
default and survives workspace stop/start **only if the home directory is on a
persistent volume**. Coder's standard Docker and Kubernetes templates do this.
Set `store_path` to point elsewhere.

`store_path` must be an absolute path (no `~`, no `.` or `..` segments, no `//`)
to a **dedicated directory used
only for CockroachDB**. `crdb-reset` deletes the directory's contents, and it
refuses any non-empty directory that doesn't look like a CockroachDB store.
The module refuses to start with a store at `/`, at `$HOME` or any parent of
it, or inside its own directory other than under `data/`. Symlinks are
resolved first, including in the parent of a directory that doesn't exist yet.

## Coming from Postgres

CockroachDB speaks the Postgres wire protocol, so `psql`, your driver, and
your ORM connect through `DATABASE_URL` unchanged. Differences you're likely
to hit in the dev loop:

- **Transaction retries.** CockroachDB runs `SERIALIZABLE` by default. Under
  contention it returns retry errors (`40001`). Use your driver's or ORM's
  retry support.
- **`SERIAL` columns** produce unique but non-sequential IDs.
- **Extensions.** Many Postgres extensions aren't available.

<!-- TODO: expand with notes from testing common Postgres app stacks (Spring Boot + Flyway, Django, Node + Prisma, Go + pgx). -->

## Restricted networks

After the binary is in place, clusters the module creates make no outbound
connections. Diagnostics reporting is disabled for them, including after
`crdb-reset`. A store created elsewhere and pointed to with `store_path` keeps
its own setting. The binary download is the only outbound request, and it
happens only when that version isn't already on disk. You can remove the
download:

- **Bake it into the image.** If `cockroach` is already on the image's `PATH`,
  the module uses it and skips the download (`crdb_version` is ignored).
  A baked-in `cockroach` must be the real binary, or a wrapper that `exec`s
  it, because the module checks that the started process is the one
  CockroachDB records.
- **Use an internal mirror:**

```tf
module "cockroachdb" {
  source     = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version    = "1.0.0"
  agent_id   = coder_agent.main.id
  binary_url = "https://artifactory.example.com/cockroachdb"
}
```

The mirror must serve the official, unmodified `cockroach-<version>.linux-<arch>.tgz`.
For the module's default version, the module checks the tarball against a
SHA-256 hash pinned in the module itself, so a mirror cannot substitute a
different file. For any other `crdb_version`, the mirror must also serve the
`.sha256sum` file next to the tarball. The tarball must contain
`cockroach-<version>.linux-<arch>/cockroach`. This is the same layout as
`binaries.cockroachdb.com`.

## Network access

The module makes these outbound requests, and only when the requested version
isn't already installed and no `cockroach` is on `PATH`:

- `GET <binary_url>/cockroach-<version>.linux-<arch>.tgz`
- For versions other than the module's default only:
  `GET <binary_url>/cockroach-<version>.linux-<arch>.tgz.sha256sum`. The
  default version is verified against a hash pinned in the module, so only the
  tarball is requested.

Nothing else connects outbound at runtime. The module needs no `sudo` or root.

## Host networking

CockroachDB runs without a password and listens on `127.0.0.1` (IPv4 loopback;
the connection URLs use that address too, so clients that prefer IPv6 for
`localhost` still connect). That's private
in normal Docker, Kubernetes, and VM workspaces.

> [!WARNING]
> If your template uses host networking (`network_mode = "host"` or
> `hostNetwork: true`) on a machine shared by several developers, the loopback
> interface is shared too, and other users may reach each other's databases. Ports will
> also collide. Don't use this module with host-networked templates on shared
> machines.

The module prints a warning in the install log when it sees signs of this. The
same warning can be a false positive in a VM workspace that runs Docker, and it
can also appear in Docker-in-Docker workspaces (envbox, sysbox), where
the loopback interface is private.

## Resource sizing

A single CockroachDB process uses about 800 MiB of resident memory and 5-10% of
one core when idle, measured on a 2 CPU / 4 GB workspace. Plan for about 1 GiB
plus your workload. A 2 CPU / 4 GB workspace is comfortable for typical
dev-loop use.

## Platform support

Linux `amd64` and `arm64` workspace agents with glibc (Alpine/musl images are
not supported; a glibc image that also has musl installed is fine). The workspace image needs `curl`, plus `tar` and `sha256sum`
unless `cockroach` is preinstalled. Other platforms fail at startup. For
unsupported architectures the error points to
[manual installation](https://www.cockroachlabs.com/docs/stable/install-cockroachdb).

## Troubleshooting

**Where to look.** The module's scripts run in the background and don't block
login, so the database may take a few seconds to come up after you log in. The
`CockroachDB: Install Script` and `CockroachDB: Start Script` logs are in the
Coder dashboard and in
`~/.coder-modules/cockroachlabs/cockroachdb/logs/install.log` and `start.log`.
The database log is `~/.coder-modules/cockroachlabs/cockroachdb/logs/cockroach.log`.
Run `crdb-start` to start it again.

**Install failed, so nothing started.** The start script fails with
`CockroachDB was not started because the install script did not finish.` and
points at `install.log`. Fix the error reported there, then restart the
workspace.

**Port already in use.** The script fails with `CockroachDB exited before
becoming ready.`, the log typically shows `address already in use`, and the
script adds `Another process is using port <sql_port> or <http_port>. Set
sql_port / http_port in the module block.` Set `sql_port` and `http_port` in
the module block (defaults 26257 and 26080).

**Download failed.** If the server answers with an HTTP error, the script
fails with `Could not download <url>. The server returned an HTTP error, so
this version may not exist at binary_url. Check crdb_version and the mirror.`
Check that `crdb_version` exists and that the mirror serves it. For any other
failure, such as a blocked network, the script fails with `Could not download
<url>. On restricted networks, set binary_url to an internal mirror or bake
cockroach into the image.` See [Restricted networks](#restricted-networks).

**TLS-inspecting proxy.** On a network that inspects TLS (a corporate proxy),
the download fails with a certificate error from `curl`, followed by the
module's message:

```text
curl: (60) SSL certificate problem: unable to get local issuer certificate
Could not download <url>. On restricted networks, set binary_url to an internal
mirror or bake cockroach into the image.
```

> [!TIP]
> Add the proxy's CA certificate to the workspace image's system trust store
> (for example `update-ca-certificates` on Debian and Ubuntu); `curl` uses it.
> Or set `binary_url` to an internal mirror that the workspace already trusts.

**Not ready in time.** The script fails with `CockroachDB not ready after Ns.`
and prints the last log lines. The process was still running but it hadn't
written its PID file and passed the health check within the timeout (60
seconds). `N` is the time actually waited. Read
`~/.coder-modules/cockroachlabs/cockroachdb/logs/cockroach.log`, then run
`crdb-start` to try again. A slow or overloaded workspace is the usual cause.

**Blank DB Console page.** The Console downloads a JavaScript bundle on first
load. Over a slow or proxied connection, an interrupted download leaves the page
blank. Refresh the page. If it stays blank, check the browser's developer tools
Network tab for a failed `bundle.js` or `uiconfig` request.

**Checksum failure.** The script fails with `Checksum verification failed for
<url>. The download may be corrupt, or the mirror may be out of date.` Re-run
the script. If it persists, check that the mirror serves the right files for
that version.

**Pinned checksum mismatch.** The script fails with `Checksum mismatch for
<url>: the file does not match the checksum pinned in this module. The mirror
may be serving a modified or different file.` This happens only for the
module's default version. The tarball at `binary_url` is not the official
file. Point `binary_url` at a mirror of the unmodified tarball, or at
`https://binaries.cockroachdb.com`.

**Missing `.sha256sum`.** The script fails with `Could not download
<url>.sha256sum. A binary_url mirror must also serve the .sha256sum file next
to the tarball.` Add the checksum file to the mirror.

**Missing tool.** The script fails with `Missing required tool: tar. Install it
in the workspace image (for example: apt-get install -y tar), or bake cockroach
into the image.` The same message appears for `sha256sum` (package `coreutils`).
For `curl` it reads `Missing required tool: curl. Install it in the workspace
image (for example: apt-get install -y curl).` `curl` is always required. `tar`
and `sha256sum` are needed only when the module downloads the binary.

**musl or Alpine image.** The script fails with `This system uses musl libc
(for example Alpine), and CockroachDB's Linux binaries need glibc.` Use a
glibc-based image such as Debian, Ubuntu, or UBI. A glibc image that also has
the `musl` package installed (for example `musl-tools`) is detected as glibc
and works.

**Disk full.** The script fails with `Could not create a temporary directory.
Check free disk space in /tmp, then re-run.`, `Could not write the download of
<url> to <dir>. Check free disk space, then re-run.`, or `Failed to extract
cockroach to <path>. Check free disk space and permissions, then re-run.` Free
some space and re-run the script.

**Changed `crdb_version` and the database won't start.** An older version
can't open a store created by a newer one, and CockroachDB upgrades one major
version at a time. Go back to the previous version. The module keeps
it on disk, so rolling back needs no download. Or run `crdb-reset` to start
fresh (this deletes all data). The module keeps only one previous version, so
after two changes in a row the earlier one has to be downloaded again.

**Shared-network warning.** The install log shows `WARNING: this workspace may
share its host's network`. See [Host networking](#host-networking).

**Helpers say the config is missing.** `crdb-start` or `crdb-reset` prints
`CockroachDB module config not found at <path>. Restart the workspace to
reinstall.` Restart the workspace so the install script runs again and
rewrites the config and helpers.

**Unsafe store path.** The install script or `crdb-start` fails with
`Refusing to use '<path>' as the CockroachDB store:` and a reason. The store
must be an absolute path with no `.`, `..`, or `//` segments. It must not be
`/`, `$HOME` or a parent of it, or a path inside
`~/.coder-modules/cockroachlabs/cockroachdb` other than under `data/`, whether
reached directly or through a symlink. Set
`store_path` to a dedicated directory.

**Starting over.** `crdb-reset` stops the database and **deletes all data** in
the store, then starts a fresh cluster. It refuses unsafe store paths:
relative paths, paths with `.` or `..` segments, `$HOME` or any parent of it,
`/`, and the module's own directory other than under `data/`. It also refuses a non-empty
directory that doesn't look like a CockroachDB store. A top-level `lost+found`
(present on a dedicated ext4 volume) is ignored and kept. `crdb-reset` also
works after a failed first start, when the directory holds only
`cockroach-temp*` entries, `temp-dirs-record.txt`, and `logs`. A `logs`
directory counts only when it holds `cockroach.log` or sits beside one of the
temp entries. A `store_path` that is a symlink is followed, and the
link itself is kept.

If a database answers on the console port but not as the process recorded in
the PID file, `crdb-reset` stops with `CockroachDB is answering on port
<http_port>, but not as the process recorded in <pid_file>; stop it first.`
Stop that process, then run `crdb-reset` again.

## Not covered by this module

- **Multi-region development.** This module runs one CockroachDB process,
  and one process can belong to only one region. Multi-region features such
  as `REGIONAL BY ROW` need a process per region. For now, use
  `cockroach demo --global` (in-memory, not persistent).
- **Secure mode / TLS.** This is a workspace-private dev database.
- **CockroachDB Cloud.** This module runs CockroachDB inside the workspace,
  matching Coder's self-hosted, in-perimeter model.
