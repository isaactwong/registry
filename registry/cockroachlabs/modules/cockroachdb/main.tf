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
  sql_url = "postgres://root@localhost:${var.sql_port}/defaultdb?sslmode=disable"
  env = {
    database_url = { name = "DATABASE_URL", value = local.sql_url }
    pghost       = { name = "PGHOST", value = "localhost" }
    pgport       = { name = "PGPORT", value = tostring(var.sql_port) }
    pguser       = { name = "PGUSER", value = "root" }
    pgdatabase   = { name = "PGDATABASE", value = "defaultdb" }
  }
}

resource "coder_env" "database_url" {
  agent_id = var.agent_id
  name     = local.env.database_url.name
  value    = local.env.database_url.value
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
  script = join("\n", [
    "#!/usr/bin/env bash",
    "export CRDB_VERSION=${jsonencode(var.crdb_version)}",
    "export STORE_PATH=${jsonencode(var.store_path)}",
    "export SQL_PORT=${jsonencode(tostring(var.sql_port))}",
    "export HTTP_PORT=${jsonencode(tostring(var.http_port))}",
    "export BINARY_URL=${jsonencode(var.binary_url)}",
    file("${path.module}/run.sh"),
  ])

  lifecycle {
    precondition {
      condition     = var.sql_port != var.http_port
      error_message = "sql_port and http_port must differ."
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
  description = "CockroachDB version installed by this module."
}
