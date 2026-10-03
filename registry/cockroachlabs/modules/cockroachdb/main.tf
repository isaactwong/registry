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
  description = "Persistent store path inside the workspace. Empty resolves to $HOME/.crdb-data. Must be on a persistent volume for data to survive workspace restarts."
  default     = ""
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

variable "share" {
  type        = string
  description = "coder_app share visibility. One of: owner, authenticated, public."
  default     = "owner"

  validation {
    condition     = contains(["owner", "authenticated", "public"], var.share)
    error_message = "share must be one of: owner, authenticated, public."
  }
}
