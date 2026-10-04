terraform {
  required_version = ">= 1.0"
  required_providers {
    coder = {
      source  = "coder/coder"
      version = ">= 2.0"
    }
  }
}

variable "agent_id" {
  type        = string
  description = "The ID of a Coder agent to attach this module to."
}

variable "crdb_version" {
  type        = string
  description = "CockroachDB version to install, e.g. v26.3.1. Defaults to the version pinned in this module release."
  default     = "v26.3.1"

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.crdb_version))
    error_message = "crdb_version must match vNN.N.N (e.g. v26.3.1)."
  }
}

variable "store_path" {
  type        = string
  description = "Absolute path of a directory dedicated to CockroachDB, inside the workspace. Empty resolves to $HOME/.crdb-data. Must be on a persistent volume for data to survive workspace restarts. crdb-reset deletes its contents."
  default     = ""

  validation {
    condition     = can(regex("^(/[^~]*)?$", var.store_path))
    error_message = "store_path must be empty or an absolute path (starting with /) that does not contain ~."
  }
}

variable "sql_port" {
  type        = number
  description = "SQL listen port."
  default     = 26257

  validation {
    condition     = var.sql_port > 1024 && var.sql_port < 65536
    error_message = "sql_port must be in the range (1024, 65536)."
  }
}

variable "http_port" {
  type        = number
  description = "DB Console listen port."
  default     = 26080

  validation {
    condition     = var.http_port > 1024 && var.http_port < 65536
    error_message = "http_port must be in the range (1024, 65536)."
  }
}

variable "binary_url" {
  type        = string
  description = "Base URL for downloading the cockroach binary. Point at an internal mirror for restricted networks. Ignored when the image already has cockroach on PATH."
  default     = "https://binaries.cockroachdb.com"

  validation {
    condition     = can(regex("^https?://", var.binary_url))
    error_message = "binary_url must start with http:// or https://."
  }
}

variable "subdomain" {
  type        = bool
  description = "Serve the DB Console on a Coder subdomain. Requires a wildcard access URL on the Coder deployment."
  default     = true
}

locals {
  # The CockroachDB version this module release installs by default. Keep it
  # equal to the crdb_version variable default (a variable default cannot
  # reference a local, and a test checks they match). scripts/bump-crdb-version.sh
  # updates both together with the hashes below.
  default_crdb_version = "v26.3.1"

  # Official SHA-256 digests of the default version's Linux tarballs, from
  # https://binaries.cockroachdb.com/cockroach-<version>.linux-<arch>.tgz.sha256sum.
  # run.sh checks the download against these, so a mirror cannot substitute a
  # different file. Other versions fall back to the mirror's .sha256sum.
  pinned_sha256 = {
    amd64 = "92b4ca979efb45068eed6f8053b1b8fccc337efb3df7ade27338bf3a9b69f600"
    arm64 = "91f78b0cf97604997a7a784cbe51da3bd956706cad23d39c235ec4f89c7af59a"
  }
  use_pinned = var.crdb_version == local.default_crdb_version

  # Values for the script prelude. Each is single-quoted for bash, with any
  # embedded single quote written as '\'' , so no value can break out.
  prelude = {
    CRDB_VERSION = var.crdb_version
    STORE_PATH   = var.store_path
    SQL_PORT     = tostring(var.sql_port)
    HTTP_PORT    = tostring(var.http_port)
    BINARY_URL   = var.binary_url
    # Empty unless crdb_version is the default version.
    PINNED_SHA256_AMD64 = local.use_pinned ? local.pinned_sha256.amd64 : ""
    PINNED_SHA256_ARM64 = local.use_pinned ? local.pinned_sha256.arm64 : ""
  }
  shq = { for k, v in local.prelude : k => "'${replace(v, "'", "'\\''")}'" }

  sql_url = "postgres://root@localhost:${var.sql_port}/defaultdb?sslmode=disable"
  env = {
    database_url = { name = "DATABASE_URL", value = local.sql_url }
    # Read by `cockroach sql` and friends, so they work with no flags.
    cockroach_url = { name = "COCKROACH_URL", value = local.sql_url }
    pghost        = { name = "PGHOST", value = "localhost" }
    pgport        = { name = "PGPORT", value = tostring(var.sql_port) }
    pguser        = { name = "PGUSER", value = "root" }
    pgdatabase    = { name = "PGDATABASE", value = "defaultdb" }
  }
}

resource "coder_env" "database_url" {
  agent_id = var.agent_id
  name     = local.env.database_url.name
  value    = local.env.database_url.value
}

resource "coder_env" "cockroach_url" {
  agent_id = var.agent_id
  name     = local.env.cockroach_url.name
  value    = local.env.cockroach_url.value
}

resource "coder_env" "pghost" {
  agent_id = var.agent_id
  name     = local.env.pghost.name
  value    = local.env.pghost.value
}

resource "coder_env" "pgport" {
  agent_id = var.agent_id
  name     = local.env.pgport.name
  value    = local.env.pgport.value
}

resource "coder_env" "pguser" {
  agent_id = var.agent_id
  name     = local.env.pguser.name
  value    = local.env.pguser.value
}

resource "coder_env" "pgdatabase" {
  agent_id = var.agent_id
  name     = local.env.pgdatabase.name
  value    = local.env.pgdatabase.value
}

resource "coder_script" "cockroachdb" {
  agent_id           = var.agent_id
  display_name       = "CockroachDB"
  icon               = "/icon/database.svg"
  run_on_start       = true
  start_blocks_login = false
  # Values are passed as env vars in a prelude, then run.sh is inlined verbatim.
  # templatefile() would require escaping every bash ${...} and would stop
  # ShellCheck from linting run.sh directly.
  script = join("\n", concat(
    ["#!/usr/bin/env bash"],
    [for k, v in local.prelude : "export ${k}=${local.shq[k]}"],
    [file("${path.module}/run.sh")],
  ))

  lifecycle {
    precondition {
      condition     = var.sql_port != var.http_port
      error_message = "sql_port and http_port must differ."
    }

    precondition {
      condition     = alltrue([for h in values(local.pinned_sha256) : can(regex("^[0-9a-f]{64}$", h))])
      error_message = "Each pinned SHA-256 in local.pinned_sha256 must be 64 lowercase hex characters."
    }
  }
}

resource "coder_app" "db_console" {
  agent_id     = var.agent_id
  slug         = "crdb-console"
  display_name = "CockroachDB Console"
  url          = "http://localhost:${var.http_port}"
  icon         = "/icon/database.svg"
  subdomain    = var.subdomain
  share        = "owner" # The console has no login in insecure mode.

  healthcheck {
    url       = "http://localhost:${var.http_port}/health?ready=1"
    interval  = 5
    threshold = 24
  }
}

output "sql_url" {
  value       = local.sql_url
  description = "SQL connection URL for the workspace-local CockroachDB."
}

output "http_url" {
  value       = "http://localhost:${var.http_port}"
  description = "DB Console URL (inside the workspace)."
}

output "version" {
  value       = var.crdb_version
  description = "The CockroachDB version this module installs when it downloads. A cockroach already on the workspace PATH takes precedence and is used instead."
}
