import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTerraformApply,
  runTerraformInit,
  testRequiredVariables,
} from "~test";

describe("cockroachdb terraform", async () => {
  await runTerraformInit(import.meta.dir);

  testRequiredVariables(import.meta.dir, { agent_id: "foo" });

  it("exports connection env vars via coder_env", async () => {
    const state = await runTerraformApply(import.meta.dir, {
      agent_id: "foo",
      sql_port: 26300,
    });
    const env = Object.fromEntries(
      state.resources
        .filter((r) => r.type === "coder_env")
        .flatMap((r) => r.instances)
        .map((i) => [i.attributes.name, i.attributes.value]),
    );
    expect(env).toEqual({
      DATABASE_URL: "postgres://root@localhost:26300/defaultdb?sslmode=disable",
      PGHOST: "localhost",
      PGPORT: "26300",
      PGUSER: "root",
      PGDATABASE: "defaultdb",
    });
  });
});

describe("run.sh", () => {
  let home: string;
  let stubs: string;
  let binDir: string;

  const pidFile = () => join(home, ".local/share/cockroachdb/crdb.pid");
  const extraPids: number[] = [];
  const spawnUnrelated = () => {
    const p = Bun.spawn(["sleep", "3600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    extraPids.push(p.pid);
    return p.pid;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "crdb-module-test-"));
    stubs = join(home, "stubs");
    binDir = join(home, "coder-bin");
    mkdirSync(stubs, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, "net"), { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(pidFile())) {
      await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`
        .nothrow()
        .quiet();
    }
    // Reap any fake cockroach whose PID file was overwritten by a test.
    await $`pkill -f ${home}/.local/share/cockroachdb`.nothrow().quiet();
    for (const pid of extraPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(home, { recursive: true, force: true });
  });

  const stub = (name: string, body: string) =>
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  const linuxAmd64 = () =>
    stub("uname", 'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi');

  // Fake cockroach: records its env, honors --pid-file, then loops (no exec)
  // so its command line stays "/bin/sh .../cockroach start-single-node ...".
  const FAKE_COCKROACH =
    '#!/bin/sh\n[ "$1" = version ] && { echo "Build Tag: v0.0.0-fake"; exit 0; }\nenv > "$HOME/cockroach.env"\nfor a in "$@"; do case "$a" in --pid-file=*) echo $$ > "${a#--pid-file=}";; esac; done\nwhile :; do sleep 1; done\n';

  const plantFakeBinary = (version: string) => {
    const dir = join(home, ".local/share/cockroachdb", version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
  };

  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    // Minimal PATH so a cockroach installed on the host can't leak in.
    PATH: `${stubs}:${binDir}:/usr/bin:/bin`,
    CODER_SCRIPT_BIN_DIR: binDir,
    CRDB_VERSION: "v26.3.1",
    STORE_PATH: "",
    SQL_PORT: "26257",
    HTTP_PORT: "26080",
    READY_TIMEOUT: "1",
    // Empty fake /sys/class/net so the host's own interfaces don't leak in.
    NET_SYS_DIR: join(home, "net"),
    ...extra,
  });

  const run = (e: Record<string, string>, cwd?: string) =>
    $`bash ${join(import.meta.dir, "run.sh")}`
      .env(e)
      .cwd(cwd ?? process.cwd())
      .nothrow()
      .quiet();

  it("rejects unsupported OS", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi');
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Unsupported OS");
  });

  it("rejects unsupported arch", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Linux; else echo mips; fi');
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Unsupported arch");
  });

  it("rejects a relative store path", async () => {
    linuxAmd64();
    const r = await run(env({ STORE_PATH: "relstore" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("must be an absolute path");
  });

  it("links cockroach and helpers into CODER_SCRIPT_BIN_DIR", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    for (const f of ["cockroach", "crdb-start", "crdb-reset"]) {
      expect(existsSync(join(binDir, f))).toBe(true);
    }
  });

  it("defaults store path to $HOME/.crdb-data", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    expect(readFileSync(join(binDir, "crdb-reset"), "utf-8")).toContain(
      join(home, ".crdb-data"),
    );
  });

  it("is idempotent when CockroachDB is already running", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    expect(existsSync(pidFile())).toBe(true);
    const second = await run(env());
    expect(second.stdout.toString()).toContain("already running");
    expect(second.exitCode).toBe(0);
  });

  it("crdb-reset wipes the store and restarts", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    const store = join(home, ".crdb-data");
    writeFileSync(join(store, "marker"), "x");
    const firstPid = readFileSync(pidFile(), "utf-8").trim();

    await $`${join(binDir, "crdb-reset")}`.env(env()).nothrow().quiet();

    expect(existsSync(join(store, "marker"))).toBe(false);
    expect(readFileSync(pidFile(), "utf-8").trim()).not.toBe(firstPid);
  });

  it("starts with diagnostics reporting disabled", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    expect(readFileSync(join(home, "cockroach.env"), "utf-8")).toContain(
      "COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING=true",
    );
  });

  it("prints recent log lines when CockroachDB is not ready", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Last log lines");
  });

  it("warns when host container interfaces are visible", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    mkdirSync(join(home, "net", "docker0"));
    const r = await run(env());
    expect(r.stderr.toString()).toContain("may share its host's network");
    // Warn only: CockroachDB still starts.
    expect(existsSync(pidFile())).toBe(true);
  });

  it("does not warn on a private network", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    mkdirSync(join(home, "net", "eth0"));
    const r = await run(env());
    expect(r.stderr.toString()).not.toContain("may share its host's network");
  });

  it("prefers a preinstalled cockroach and skips the download", async () => {
    linuxAmd64();
    // The readiness check also uses curl, so only flag download calls (-o).
    stub("curl", 'case "$*" in *-o*) touch "$HOME/downloaded";; esac; exit 22');
    writeFileSync(join(stubs, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
    await run(env());
    expect(existsSync(join(home, "downloaded"))).toBe(false);
    expect(existsSync(join(binDir, "cockroach"))).toBe(false);
    expect(readFileSync(join(binDir, "crdb-start"), "utf-8")).toContain(
      join(stubs, "cockroach"),
    );
  });

  it("downloads from BINARY_URL when set", async () => {
    linuxAmd64();
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 1");
    await run(env({ BINARY_URL: "https://mirror.example/crdb/" }));
    expect(readFileSync(join(home, "curl.log"), "utf-8")).toContain(
      "https://mirror.example/crdb/cockroach-v26.3.1.linux-amd64.tgz",
    );
  });

  it("downloads and verifies checksum when binary is absent", async () => {
    linuxAmd64();
    // curl writes nothing useful; sha256sum stub fails, simulating a mismatch.
    stub(
      "curl",
      'while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "echo 'FAILED' >&2; exit 1");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(binDir, "cockroach"))).toBe(false);
    expect(r.stderr.toString()).toContain("Checksum verification failed");
  });

  it("explains a missing .sha256sum on the mirror", async () => {
    linuxAmd64();
    stub(
      "curl",
      'case "$*" in *.sha256sum*) exit 22;; esac; while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 0");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(".sha256sum");
    expect(r.stderr.toString()).toContain("mirror");
  });

  it("reports ready and exits 0 when the health check passes", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary("v26.3.1");
    const r = await run(env());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("CockroachDB ready");
  });

  it("treats a PID reused by an unrelated process as stale", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const other = spawnUnrelated();
    mkdirSync(join(home, ".local/share/cockroachdb"), { recursive: true });
    writeFileSync(pidFile(), String(other));
    const r = await run(env());
    expect(r.stdout.toString()).not.toContain("already running");
    expect(readFileSync(pidFile(), "utf-8").trim()).not.toBe(String(other));
    expect(alive(other)).toBe(true);
  });

  it("crdb-reset never signals an unrelated process at the PID", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    const other = spawnUnrelated();
    writeFileSync(pidFile(), String(other));
    await $`${join(binDir, "crdb-reset")}`.env(env()).nothrow().quiet();
    expect(alive(other)).toBe(true);
  });

  it("crdb-reset refuses to wipe $HOME", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env({ STORE_PATH: home }));
    const r = await $`${join(binDir, "crdb-reset")}`
      .env(env())
      .nothrow()
      .quiet();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(home, "stubs"))).toBe(true);
  });

  it("crdb-reset refuses a store inside the module state dir", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const inside = join(home, ".local/share/cockroachdb/data");
    await run(env({ STORE_PATH: inside }));
    const r = await $`${join(binDir, "crdb-reset")}`
      .env(env())
      .nothrow()
      .quiet();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(home, ".local/share/cockroachdb", "v26.3.1"))).toBe(
      true,
    );
  });

  it("fails fast when CockroachDB exits before becoming ready", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    const dir = join(home, ".local/share/cockroachdb/v26.3.1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cockroach"),
      '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "ERROR: address already in use" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const t0 = Date.now();
    const r = await run(env({ READY_TIMEOUT: "30" }));
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("address already in use");
  });

  it("leaves no partial binary when extraction fails", async () => {
    linuxAmd64();
    stub(
      "curl",
      'while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 0");
    stub("tar", "exit 1");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("disk space");
    const bin = join(home, ".local/share/cockroachdb/v26.3.1/cockroach");
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(`${bin}.partial`)).toBe(false);
  });
});
