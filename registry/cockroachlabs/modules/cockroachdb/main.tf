terraform {
  required_version = ">= 1.0"
  required_providers {
    coder = {
      source = "coder/coder"
      # coder-utils requires >= 2.13.
      version = ">= 2.13"
    }
  }
}

variable "agent_id" {
  description = "The ID of a Coder agent to attach this module to."
  type        = string
}

variable "crdb_version" {
  description = "CockroachDB version to install, e.g. v26.3.1. Defaults to the version pinned in this module release."
  type        = string
  default     = "v26.3.1"

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.crdb_version))
    error_message = "crdb_version must match vNN.N.N (e.g. v26.3.1)."
  }
}

variable "store_path" {
  description = "Absolute path of a directory dedicated to CockroachDB, inside the workspace. Empty resolves to $HOME/.coder-modules/cockroachlabs/cockroachdb/data. Must be on a persistent volume for data to survive workspace restarts. crdb-reset deletes its contents."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^(/[^~]*)?$", var.store_path)) && !can(regex("^/+$", var.store_path))
    error_message = "store_path must be empty or an absolute path (starting with /) that does not contain ~ and is not /."
  }
}

variable "sql_port" {
  description = "SQL listen port."
  type        = number
  default     = 26257

  validation {
    condition     = var.sql_port > 1024 && var.sql_port < 65536
    error_message = "sql_port must be in the range (1024, 65536)."
  }
}

variable "http_port" {
  description = "DB Console listen port."
  type        = number
  default     = 26080

  validation {
    condition     = var.http_port > 1024 && var.http_port < 65536
    error_message = "http_port must be in the range (1024, 65536)."
  }
}

variable "binary_url" {
  description = "Base URL for downloading the cockroach binary. Point at an internal mirror for restricted networks. Ignored when the image already has cockroach on PATH."
  type        = string
  default     = "https://binaries.cockroachdb.com"

  validation {
    condition     = can(regex("^https?://", var.binary_url))
    error_message = "binary_url must start with http:// or https://."
  }
}

variable "subdomain" {
  description = "Serve the DB Console on a Coder subdomain. Requires a wildcard access URL on the Coder deployment."
  type        = bool
  default     = true
}

variable "order" {
  description = "The order determines the position of app in the UI presentation. The lowest order is shown first and apps with equal order are sorted by name (ascending order)."
  type        = number
  default     = null
}

locals {
  module_dir_name = ".coder-modules/cockroachlabs/cockroachdb"
  icon            = "/icon/cockroachdb.svg"

  # A variable default cannot reference a local, so this must be kept equal to
  # the crdb_version default by hand; a test checks they match. Bumping the
  # default version is manual: change this local, the variable default, and
  # both hashes below, taken from the official .sha256sum files.
  default_crdb_version = "v26.3.1"

  # Official SHA-256 digests of the default version's Linux tarballs, from
  # https://binaries.cockroachdb.com/cockroach-<version>.linux-<arch>.tgz.sha256sum.
  # The install script checks the download against these, so a mirror cannot
  # substitute a different file. Other versions fall back to the mirror's
  # .sha256sum.
  pinned_sha256 = {
    amd64 = "92b4ca979efb45068eed6f8053b1b8fccc337efb3df7ade27338bf3a9b69f600"
    arm64 = "91f78b0cf97604997a7a784cbe51da3bd956706cad23d39c235ec4f89c7af59a"
  }
  use_pinned = var.crdb_version == local.default_crdb_version

  install_script = templatefile("${path.module}/scripts/install.sh.tftpl", {
    ARG_MODULE_DIR_NAME     = local.module_dir_name
    ARG_CRDB_VERSION        = var.crdb_version
    ARG_STORE_PATH          = base64encode(var.store_path)
    ARG_SQL_PORT            = tostring(var.sql_port)
    ARG_HTTP_PORT           = tostring(var.http_port)
    ARG_BINARY_URL          = base64encode(var.binary_url)
    ARG_PINNED_SHA256_AMD64 = local.use_pinned ? local.pinned_sha256.amd64 : ""
    ARG_PINNED_SHA256_ARM64 = local.use_pinned ? local.pinned_sha256.arm64 : ""
  })
  start_script = templatefile("${path.module}/scripts/start.sh.tftpl", {
    ARG_MODULE_DIR_NAME = local.module_dir_name
  })

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

module "coder_utils" {
  source  = "registry.coder.com/coder/coder-utils/coder"
  version = "0.0.1"

  agent_id            = var.agent_id
  module_directory    = "$HOME/${local.module_dir_name}"
  display_name_prefix = "CockroachDB"
  icon                = local.icon
  install_script      = local.install_script
  start_script        = local.start_script
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

resource "coder_app" "db_console" {
  agent_id     = var.agent_id
  slug         = "crdb-console"
  display_name = "CockroachDB Console"
  url          = "http://localhost:${var.http_port}"
  icon         = local.icon
  subdomain    = var.subdomain
  share        = "owner" # The console has no login in insecure mode.
  order        = var.order

  healthcheck {
    url       = "http://localhost:${var.http_port}/health?ready=1"
    interval  = 5
    threshold = 24
  }

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

output "sql_url" {
  description = "SQL connection URL for the workspace-local CockroachDB."
  value       = local.sql_url
}

output "http_url" {
  description = "DB Console URL (inside the workspace)."
  value       = "http://localhost:${var.http_port}"
}

output "version" {
  description = "The CockroachDB version this module installs when it downloads. A cockroach already on the workspace PATH takes precedence and is used instead."
  value       = var.crdb_version
}

output "scripts" {
  description = "Ordered list of coder exp sync names produced by this module, in run order."
  value       = module.coder_utils.scripts
}
