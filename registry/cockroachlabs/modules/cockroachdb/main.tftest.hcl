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
    condition     = var.subdomain == true
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

run "relative_store_path_rejected" {
  command = plan

  variables {
    agent_id   = "test-agent-id"
    store_path = "data/crdb"
  }

  expect_failures = [var.store_path]
}

run "tilde_store_path_rejected" {
  command = plan

  variables {
    agent_id   = "test-agent-id"
    store_path = "/home/coder/~/crdb"
  }

  expect_failures = [var.store_path]
}

run "absolute_store_path_accepted" {
  command = plan

  variables {
    agent_id   = "test-agent-id"
    store_path = "/data/crdb"
  }
}

run "out_of_range_port_rejected" {
  command = plan

  variables {
    agent_id = "test-agent-id"
    sql_port = 80
  }

  expect_failures = [var.sql_port]
}

run "resources_configured" {
  command = plan

  variables {
    agent_id = "test-agent-id"
  }

  assert {
    condition     = coder_script.cockroachdb.agent_id == "test-agent-id" && coder_script.cockroachdb.run_on_start
    error_message = "coder_script not wired correctly"
  }

  assert {
    condition     = coder_script.cockroachdb.start_blocks_login == false
    error_message = "coder_script must not block login"
  }

  assert {
    condition     = coder_app.db_console.url == "http://localhost:26080" && coder_app.db_console.subdomain
    error_message = "coder_app url/subdomain defaults incorrect"
  }

  assert {
    condition     = coder_app.db_console.share == "owner"
    error_message = "DB Console must always be owner-only"
  }

  assert {
    condition     = coder_env.database_url.value == "postgres://root@localhost:26257/defaultdb?sslmode=disable"
    error_message = "DATABASE_URL incorrect"
  }
}

run "outputs_reflect_inputs" {
  command = plan

  variables {
    agent_id     = "test-agent-id"
    crdb_version = "v26.2.0"
    sql_port     = 26300
    http_port    = 26090
  }

  assert {
    condition     = output.sql_url == "postgres://root@localhost:26300/defaultdb?sslmode=disable"
    error_message = "sql_url should reflect sql_port"
  }

  assert {
    condition     = output.http_url == "http://localhost:26090"
    error_message = "http_url should reflect http_port"
  }

  assert {
    condition     = output.version == "v26.2.0"
    error_message = "version should reflect crdb_version"
  }
}

run "port_collision_rejected" {
  command = plan

  variables {
    agent_id  = "test-agent-id"
    sql_port  = 26257
    http_port = 26257
  }

  expect_failures = [coder_script.cockroachdb]
}
