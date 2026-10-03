run "defaults" {
  command = plan

  variables {
    agent_id = "test-agent-id"
  }

  assert {
    condition     = var.crdb_version == "v26.3.1"
    error_message = "crdb_version default should be the pinned release"
  }

  assert {
    condition     = var.store_path == ""
    error_message = "store_path should default to empty (resolved at runtime)"
  }

  assert {
    condition     = var.sql_port == 26257 && var.http_port == 26080
    error_message = "port defaults incorrect"
  }

  assert {
    condition     = var.subdomain == true && var.share == "owner"
    error_message = "app defaults incorrect"
  }

  assert {
    condition     = var.binary_url == "https://binaries.cockroachdb.com"
    error_message = "binary_url default incorrect"
  }
}

run "invalid_binary_url_rejected" {
  command = plan

  variables {
    agent_id   = "test-agent-id"
    binary_url = "binaries.cockroachdb.com"
  }

  expect_failures = [var.binary_url]
}

run "invalid_version_rejected" {
  command = plan

  variables {
    agent_id     = "test-agent-id"
    crdb_version = "26.3.1"
  }

  expect_failures = [var.crdb_version]
}

run "empty_version_rejected" {
  command = plan

  variables {
    agent_id     = "test-agent-id"
    crdb_version = ""
  }

  expect_failures = [var.crdb_version]
}

run "invalid_share_rejected" {
  command = plan

  variables {
    agent_id = "test-agent-id"
    share    = "private"
  }

  expect_failures = [var.share]
}

run "out_of_range_port_rejected" {
  command = plan

  variables {
    agent_id = "test-agent-id"
    sql_port = 80
  }

  expect_failures = [var.sql_port]
}
