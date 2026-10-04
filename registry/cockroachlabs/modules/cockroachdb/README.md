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

The helper commands live in Coder's script bin directory. If they're missing
on a long-lived VM, restart the workspace.

The database runs in insecure mode. The SQL port listens on `localhost` only,
so it is not reachable from outside the workspace (see [Host networking](#host-networking)).

The DB Console is different. Coder proxies it through a `coder_app`, and in
this insecure dev mode it has no login. The module therefore always limits the
console to the workspace owner (and Coder site admins).

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

<!-- TODO(task 6): Update this section after Task 6's path-based app routing check confirms whether the
DB Console works behind path-based routing. If it doesn't, replace this example
with a note that `subdomain = true` is required, and enforce it with a
validation. -->

## Persistence

Data lives at `$HOME/.crdb-data` by default and survives workspace stop/start
**only if the home directory is on a persistent volume**. Coder's standard
Docker and Kubernetes templates do this. Set `store_path` to point elsewhere.

`store_path` must be an absolute path (no `~`) to a **dedicated directory used
only for CockroachDB**. `crdb-reset` deletes the directory's contents, and it
refuses any non-empty directory that doesn't look like a CockroachDB store.

## Coming from Postgres

CockroachDB speaks the Postgres wire protocol, so `psql`, your driver, and
your ORM connect through `DATABASE_URL` unchanged. Differences you're likely
to hit in the dev loop:

- **Transaction retries.** CockroachDB runs `SERIALIZABLE` by default. Under
  contention it returns retry errors (`40001`). Use your driver's or ORM's
  retry support.
- **`SERIAL` columns** produce unique but non-sequential IDs.
- **Extensions.** Many Postgres extensions aren't available.

<!-- TODO(task 6): Fill in and expand from the Task 6 sample-app results, one
entry per change a stack needed. Link to the CockroachDB PostgreSQL
compatibility docs and MOLT Schema Conversion. -->

## Restricted networks

After the binary is in place, clusters the module creates make no outbound
connections. Diagnostics reporting is disabled for them, including after
`crdb-reset`. A store created elsewhere and pointed to with `store_path` keeps
its own setting. The binary download is the only outbound request, and it
happens only when that version isn't already on disk. You can remove the
download:

- **Bake it into the image.** If `cockroach` is already on the image's `PATH`,
  the module uses it and skips the download (`crdb_version` is ignored).
- **Use an internal mirror:**

```tf
module "cockroachdb" {
  source     = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version    = "1.0.0"
  agent_id   = coder_agent.main.id
  binary_url = "https://artifactory.example.com/cockroachdb"
}
```

The mirror must serve `cockroach-<version>.linux-<arch>.tgz` and its
`.sha256sum`. The tarball must contain
`cockroach-<version>.linux-<arch>/cockroach`. This is the same layout as
`binaries.cockroachdb.com`.

## Network access

The module makes these outbound requests, and only when the requested version
isn't already installed and no `cockroach` is on `PATH`:

- `GET <binary_url>/cockroach-<version>.linux-<arch>.tgz`
- `GET <binary_url>/cockroach-<version>.linux-<arch>.tgz.sha256sum`

Nothing else connects outbound at runtime. The module needs no `sudo` or root.

## Host networking

CockroachDB runs without a password and listens on `localhost`. That's private
in normal Docker, Kubernetes, and VM workspaces. If your template uses host
networking (`network_mode = "host"` or `hostNetwork: true`) on a machine shared
by several developers, `localhost` is shared too, and other users may reach
each other's databases. Ports will also collide. Don't use this module with
host-networked templates on shared machines. The module prints a warning in the
script log when it sees signs of this. The same warning can be a false
positive in a VM workspace that runs Docker, and it can also appear in
Docker-in-Docker workspaces (envbox, sysbox), where `localhost` is private.

## Resource sizing

A single CockroachDB process uses about 512 MB–1 GB of RAM at rest and grows with
workload. A 2 CPU / 4 GB workspace is comfortable for typical dev-loop use.

## Platform support

Linux `amd64` and `arm64` workspace agents with glibc (Alpine/musl images are
not supported; a glibc image that also has musl installed is fine). The workspace image needs `curl`, plus `tar` and `sha256sum`
unless `cockroach` is preinstalled. Other platforms fail at startup. For
unsupported architectures the error points to
[manual installation](https://www.cockroachlabs.com/docs/stable/install-cockroachdb).

## Troubleshooting

**Where to look.** The startup script runs in the background and doesn't block
login, so the database may take a few seconds to come up after you log in. The
script's output is in the Coder dashboard (the CockroachDB script log). The
database log is `~/.local/share/cockroachdb/crdb.log`. Run `crdb-start` to
start it again.

**Port already in use.** The script fails with `CockroachDB exited before
becoming ready.` and the log typically shows `address already in use`. Set `sql_port` and
`http_port` in the module block (defaults 26257 and 26080).

**Download blocked.** The script fails with `Could not download <url>. On
restricted networks, set binary_url to an internal mirror or bake cockroach
into the image.` See [Restricted networks](#restricted-networks).

**Not ready in time.** The script fails with `CockroachDB not ready after Ns.`
and prints the last log lines. The process was still running but it hadn't
written its PID file and passed the health check within the timeout (60
seconds). Read
`~/.local/share/cockroachdb/crdb.log`, then run `crdb-start` to try again. A
slow or overloaded workspace is the usual cause.

**Checksum failure.** The script fails with `Checksum verification failed for
<url>. The download may be corrupt, or the mirror may be out of date.` Re-run
the script. If it persists, check that the mirror serves the right files for
that version.

**Missing `.sha256sum`.** The script fails with `Could not download
<url>.sha256sum. A binary_url mirror must also serve the .sha256sum file next
to the tarball.` Add the checksum file to the mirror.

**Missing tool.** The script fails with `Missing required tool: curl` (or
`tar`, or `sha256sum`). Install it in the workspace image. `curl` is always
required. `tar` and `sha256sum` are needed only when the module downloads the
binary.

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
version at a time. Go back to the previous version, or run `crdb-reset` to
start fresh (this deletes all data).

**Shared-network warning.** The script log shows `WARNING: this workspace may
share its host's network`. See [Host networking](#host-networking).

**Helpers say the config is missing.** `crdb-start` or `crdb-reset` prints
`CockroachDB module config not found at <path>. Restart the workspace to
reinstall.` Restart the workspace so the module script runs again and rewrites
the config and helpers.

**Starting over.** `crdb-reset` stops the database and **deletes all data** in
the store, then starts a fresh cluster. It refuses unsafe store paths:
relative paths, paths with `.` or `..` segments, `$HOME` or any parent of it,
`/`, and the module's own state directory. It also refuses a non-empty
directory that doesn't look like a CockroachDB store. A top-level `lost+found`
(present on a dedicated ext4 volume) is ignored and kept. `crdb-reset` also
works after a failed first start, when the directory holds only `logs` or
`cockroach-temp*` entries. A `store_path` that is a symlink is followed, and the
link itself is kept.

If a database answers on the console port but the PID file is missing,
`crdb-reset` stops with `CockroachDB appears to be running on port <http_port>
but its PID file is missing; stop it first.` Stop that process, then run
`crdb-reset` again.

## Not covered by this module

- **Multi-region development.** This module runs one CockroachDB process,
  and one process can belong to only one region. Multi-region features such
  as `REGIONAL BY ROW` need a process per region. For now, use
  `cockroach demo --global` (in-memory, not persistent).
- **Secure mode / TLS.** This is a workspace-private dev database.
- **CockroachDB Cloud.** This module runs CockroachDB inside the workspace,
  matching Coder's self-hosted, in-perimeter model.
