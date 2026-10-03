---
display_name: CockroachDB
description: Runs a single, persistent CockroachDB process inside a Coder workspace, with env vars, CLI, and DB Console pre-wired.
icon: ../../../../.icons/cockroachdb.svg
maintainer_github: cockroachdb
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
- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE` are set in
  every workspace session (terminal, SSH, IDE), in any shell.
- The `cockroach` CLI is on `PATH`, so `cockroach sql --insecure` works.
- A **CockroachDB Console** button in the Coder dashboard.
- `crdb-start` restarts the database if it was stopped.
- `crdb-reset` stops the database, wipes the store, and starts a fresh cluster.

The database runs in insecure mode on `localhost` only. It is not reachable
from outside the workspace.

## Examples

### Pin a CockroachDB version

```tf
module "cockroachdb" {
  source       = "registry.coder.com/cockroachlabs/cockroachdb/coder"
  version      = "1.0.0"
  agent_id     = coder_agent.main.id
  crdb_version = "v26.2.0"
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

<!-- TODO(task 6): Update this section after Task 6 Step 6 confirms whether the
DB Console works behind path-based routing. If it doesn't, replace this example
with a note that `subdomain = true` is required, and enforce it with a
validation. -->

## Persistence

Data lives at `$HOME/.crdb-data` by default and survives workspace stop/start
**only if the home directory is on a persistent volume**. Coder's standard
Docker and Kubernetes templates do this. Set `store_path` to point elsewhere.

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

After the binary is in place, CockroachDB makes no outbound connections.
Diagnostics reporting is disabled by the module. The binary download is the
only outbound request, and it happens only when that version isn't already
on disk. You can remove it:

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
`.sha256sum` with the same layout as `binaries.cockroachdb.com`.

## Host networking

CockroachDB runs without a password and listens on `localhost`. That's private
in normal Docker, Kubernetes, and VM workspaces. If your template uses host
networking (`network_mode = "host"` or `hostNetwork: true`) on a machine shared
by several developers, `localhost` is shared too, and other users may reach
each other's databases. Ports will also collide. Don't use this module with
host-networked templates on shared machines. The module prints a warning in the
script log when it sees signs of this.

## Resource sizing

A single CockroachDB process uses about 512 MB–1 GB of RAM at rest and grows with
workload. A 2 CPU / 4 GB workspace is comfortable for typical dev-loop use.

## Platform support

Linux `amd64` and `arm64` workspace agents with glibc (Alpine/musl images are
not supported). The workspace image needs `curl`, plus `tar` and `sha256sum`
unless `cockroach` is preinstalled. Other platforms fail at startup. For
unsupported architectures the error points to
[manual installation](https://www.cockroachlabs.com/docs/stable/install-cockroachdb).

## Not covered by this module

- **Multi-region development.** This module runs one CockroachDB process,
  and one process can belong to only one region. Multi-region features such
  as `REGIONAL BY ROW` need a process per region. For now, use
  `cockroach demo --global` (in-memory, not persistent).
- **Secure mode / TLS.** This is a workspace-private dev database.
- **CockroachDB Cloud.** This module runs CockroachDB inside the workspace,
  matching Coder's self-hosted, in-perimeter model.
