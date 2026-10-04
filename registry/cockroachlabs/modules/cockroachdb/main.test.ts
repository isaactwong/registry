import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      COCKROACH_URL:
        "postgres://root@localhost:26300/defaultdb?sslmode=disable",
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
  const configFile = () => join(home, ".local/share/cockroachdb/config.env");
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
    '#!/bin/sh\n[ "$1" = version ] && { echo "Build Tag: v0.0.0-fake"; exit 0; }\nenv > "$HOME/cockroach.env"\nprintf "%s\\n" "$@" > "$HOME/cockroach.args"\nfor a in "$@"; do case "$a" in --pid-file=*) echo $$ > "${a#--pid-file=}";; esac; done\nwhile :; do sleep 1; done\n';

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

  it("runs the composed coder_script with a store path needing quoting", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary("v26.3.1");
    const store = join(home, "my data", "$x");
    const state = await runTerraformApply(import.meta.dir, {
      agent_id: "foo",
      sql_port: 26300,
      store_path: store,
    });
    const script = state.resources
      .filter((r) => r.type === "coder_script")
      .flatMap((r) => r.instances)[0].attributes.script as string;
    const scriptFile = join(home, "composed.sh");
    writeFileSync(scriptFile, script);
    // The prelude must supply these; do not pre-set them.
    const e: Record<string, string> = env();
    for (const k of ["CRDB_VERSION", "STORE_PATH", "SQL_PORT", "HTTP_PORT"]) {
      delete e[k];
    }
    const r = await $`bash ${scriptFile}`.env(e).nothrow().quiet();
    expect(r.exitCode).toBe(0);
    const args = readFileSync(join(home, "cockroach.args"), "utf-8")
      .trim()
      .split("\n");
    expect(args).toContain(`--store=${store}`);
    expect(args).toContain("--listen-addr=localhost:26300");
  });

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
    expect(readFileSync(configFile(), "utf-8")).toContain(
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
    writeFileSync(join(store, "CURRENT"), "MANIFEST-000001\n");
    writeFileSync(join(store, "MANIFEST-000001"), "x");
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
    expect(readFileSync(configFile(), "utf-8")).toContain(
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

  // Plants a directory that looks like a CockroachDB store.
  const fakeStore = (dir: string, marker = false) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MANIFEST-000001"), "x");
    writeFileSync(
      join(dir, marker ? "marker.manifest.000001.MANIFEST-000001" : "CURRENT"),
      "x",
    );
    writeFileSync(join(dir, "000002.log"), "x");
  };

  const reset = () =>
    $`${join(binDir, "crdb-reset")}`.env(env()).nothrow().quiet();

  // Serves a tarball shaped like the real download via the curl stub.
  const serveTarball = async (withLib: boolean) => {
    const prefix = "cockroach-v26.3.1.linux-amd64";
    const src = join(home, "tarball-src");
    mkdirSync(join(src, prefix, "lib"), { recursive: true });
    writeFileSync(join(src, prefix, "cockroach"), FAKE_COCKROACH, {
      mode: 0o755,
    });
    if (withLib) writeFileSync(join(src, prefix, "lib", "libgeos.so"), "geos");
    else rmSync(join(src, prefix, "lib"), { recursive: true });
    await $`tar -czf ${join(home, "fixture.tgz")} -C ${src} ${prefix}`.quiet();
    stub(
      "curl",
      'case "$*" in *health*) exit 0;; esac; while [ $# -gt 0 ]; do case "$1" in -o) shift; case "$1" in *.sha256sum) : > "$1";; *) cp "$HOME/fixture.tgz" "$1";; esac;; esac; shift; done',
    );
    stub("sha256sum", "exit 0");
  };

  it("crdb-reset refuses an ancestor of $HOME", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env({ STORE_PATH: dirname(home) }));
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(home, "stubs"))).toBe(true);
  });

  it("crdb-reset refuses a path with .. segments", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = `${home}/a/../b`;
    fakeStore(join(home, "b"));
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(home, "b", "CURRENT"))).toBe(true);
  });

  it("crdb-reset refuses a non-empty directory that is not a store", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "projects");
    mkdirSync(store);
    writeFileSync(join(store, "precious.txt"), "x");
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      "does not look like a CockroachDB store",
    );
    expect(existsSync(join(store, "precious.txt"))).toBe(true);
  });

  it("crdb-reset keeps the store directory itself", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "mount point");
    fakeStore(store);
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(store)).toBe(true);
    expect(existsSync(join(store, "CURRENT"))).toBe(false);
    expect(existsSync(join(store, "000002.log"))).toBe(false);
  });

  it("crdb-reset recognizes a store that uses marker files", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "newstore");
    fakeStore(store, true);
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "MANIFEST-000001"))).toBe(false);
  });

  it("crdb-reset wipes an empty store directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
  });

  it("crdb-reset empties a store reached through a symlink", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const target = join(home, "crdb-target");
    const link = join(home, "crdb-link");
    fakeStore(target);
    symlinkSync(target, link);
    await run(env({ STORE_PATH: link }));
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(target, "CURRENT"))).toBe(false);
    expect(existsSync(join(target, "000002.log"))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("crdb-reset ignores and keeps lost+found", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "volume");
    mkdirSync(join(store, "lost+found"), { recursive: true });
    writeFileSync(join(store, "lost+found", "orphan"), "x");
    // Only lost+found: counts as empty.
    await run(env({ STORE_PATH: store }));
    let r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    // lost+found plus a real store.
    fakeStore(store);
    r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "CURRENT"))).toBe(false);
    expect(existsSync(join(store, "lost+found", "orphan"))).toBe(true);
  });

  it("crdb-reset accepts the leftovers of a failed first start", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "failedstore");
    mkdirSync(join(store, "logs"), { recursive: true });
    writeFileSync(join(store, "logs", "cockroach.log"), "x");
    mkdirSync(join(store, "cockroach-temp123"));
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "logs"))).toBe(false);
  });

  it("crdb-reset accepts a store identified by its version file", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    const store = join(home, "versioned");
    mkdirSync(store);
    writeFileSync(join(store, "COCKROACHDB_VERSION"), "x");
    writeFileSync(join(store, "other"), "x");
    await run(env({ STORE_PATH: store }));
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "other"))).toBe(false);
  });

  it("crdb-reset refuses to wipe a live database without a PID file", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    const store = join(home, ".crdb-data");
    fakeStore(store);
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      "CockroachDB appears to be running on port 26080 but its PID file is missing; stop it first.",
    );
    expect(existsSync(join(store, "CURRENT"))).toBe(true);
  });

  it("crdb-reset refuses a relative store path from the config", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    await run(env());
    writeFileSync(
      configFile(),
      readFileSync(configFile(), "utf-8").replace(
        /^STORE_PATH=.*$/m,
        "STORE_PATH=relstore",
      ),
    );
    const cwd = join(home, "work");
    mkdirSync(join(cwd, "relstore"), { recursive: true });
    writeFileSync(join(cwd, "relstore", "precious"), "x");
    const r = await $`${join(binDir, "crdb-reset")}`
      .env(env())
      .cwd(cwd)
      .nothrow()
      .quiet();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(cwd, "relstore", "precious"))).toBe(true);
  });

  it("fails before downloading on a musl system", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", 'echo "$@" >> "$HOME/curl.log"; exit 22');
    const libc = join(home, "libc");
    mkdirSync(libc);
    writeFileSync(join(libc, "ld-musl-x86_64.so.1"), "");
    const r = await run(env({ LIBC_PROBE_DIR: libc }));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("glibc");
    expect(existsSync(join(home, "curl.log"))).toBe(false);
  });

  it("reports a disk-full download write error", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 23");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Could not write");
    expect(r.stderr.toString()).toContain("free disk space");
    expect(r.stderr.toString()).not.toContain("restricted networks");
  });

  it("reports a temp directory that cannot be created", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 22");
    stub("mktemp", "exit 1");
    const r = await run(env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("temporary directory");
    expect(r.stderr.toString()).toContain("disk space");
  });

  it("requires curl even when cockroach is preinstalled", async () => {
    linuxAmd64();
    writeFileSync(join(stubs, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
    // Stubs only: no /usr/bin, so no curl on PATH.
    const r = await $`/bin/bash ${join(import.meta.dir, "run.sh")}`
      .env(env({ PATH: stubs }))
      .nothrow()
      .quiet();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Missing required tool: curl");
  });

  it("does not report ready when our process has exited", async () => {
    linuxAmd64();
    // Health answers (as if another process held the port), but ours dies.
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    const dir = join(home, ".local/share/cockroachdb/v26.3.1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cockroach"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const r = await run(env({ READY_TIMEOUT: "5" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).not.toContain("CockroachDB ready");
    expect(r.stderr.toString()).toContain("exited before becoming ready");
  });

  it("does not report ready until our process writes its PID file", async () => {
    linuxAmd64();
    // Another process answers health, while our child stays alive but never
    // gets as far as writing --pid-file.
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    const dir = join(home, ".local/share/cockroachdb/v26.3.1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cockroach"),
      '#!/bin/sh\n[ "$1" = version ] && exit 0\nwhile :; do sleep 1; done\n',
      { mode: 0o755 },
    );
    const r = await run(env({ READY_TIMEOUT: "2" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).not.toContain("CockroachDB ready");
    expect(r.stderr.toString()).toContain("not ready after 2s");
  });

  it("bounds readiness and health checks with a curl timeout", async () => {
    linuxAmd64();
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; case "$*" in *health*) exit 0;; esac; exit 22',
    );
    plantFakeBinary("v26.3.1");
    const r = await run(env());
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(join(home, "curl.log"), "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.includes("health"));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("--max-time 2");
  });

  it("installs the spatial libraries next to the binary", async () => {
    linuxAmd64();
    await serveTarball(true);
    const r = await run(env());
    expect(r.exitCode).toBe(0);
    const ver = join(home, ".local/share/cockroachdb/v26.3.1");
    expect(existsSync(join(ver, "cockroach"))).toBe(true);
    expect(readFileSync(join(ver, "lib/libgeos.so"), "utf-8")).toBe("geos");
  });

  it("installs fine when the tarball has no lib directory", async () => {
    linuxAmd64();
    await serveTarball(false);
    const r = await run(env());
    expect(r.exitCode).toBe(0);
    const ver = join(home, ".local/share/cockroachdb/v26.3.1");
    expect(existsSync(join(ver, "cockroach"))).toBe(true);
    expect(existsSync(join(ver, "lib"))).toBe(false);
  });

  it("removes other version directories after a download", async () => {
    linuxAmd64();
    await serveTarball(true);
    const state = join(home, ".local/share/cockroachdb");
    mkdirSync(join(state, "v26.2.0"), { recursive: true });
    writeFileSync(join(state, "v26.2.0", "cockroach"), "old");
    writeFileSync(join(state, "crdb.log"), "log\n");
    const r = await run(env());
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(state, "v26.2.0"))).toBe(false);
    expect(existsSync(join(state, "v26.3.1/cockroach"))).toBe(true);
    expect(existsSync(join(state, "crdb.log"))).toBe(true);
    expect(existsSync(join(state, "config.env"))).toBe(true);
    expect(existsSync(pidFile())).toBe(true);
  });

  it("keeps other versions when no download happens", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary("v26.3.1");
    plantFakeBinary("v26.2.0");
    await run(env());
    expect(
      existsSync(join(home, ".local/share/cockroachdb/v26.2.0/cockroach")),
    ).toBe(true);
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
