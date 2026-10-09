import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
  type TerraformState,
} from "~test";

// Each script test renders the module with terraform apply first.
setDefaultTimeout(60_000);

// Read from main.tf so a version bump needs no test changes.
const DEFAULT_VERSION = readFileSync(
  join(import.meta.dir, "main.tf"),
  "utf-8",
).match(/^\s*default_crdb_version\s*=\s*"(v[0-9.]+)"$/m)![1];
// A non-default version: no pinned hash, so the mirror's .sha256sum is used.
const OTHER_VERSION = "v0.0.1";
const MODULE_ROOT = ".coder-modules/cockroachlabs/cockroachdb";
const INSTALL = "CockroachDB: Install Script";
const START = "CockroachDB: Start Script";

interface Scripts {
  install: string;
  start: string;
}

const coderScripts = (state: TerraformState) =>
  state.resources
    .filter((r) => r.type === "coder_script")
    .flatMap((r) => r.instances)
    .map((i) => i.attributes as Record<string, unknown>);

const collectScripts = (state: TerraformState): Scripts => {
  const byName: Record<string, string> = {};
  for (const a of coderScripts(state)) {
    byName[a.display_name as string] = a.script as string;
  }
  if (!byName[INSTALL] || !byName[START]) {
    throw new Error(
      `expected "${INSTALL}" and "${START}" coder_scripts, got: ${Object.keys(byName).join(", ")}`,
    );
  }
  return { install: byName[INSTALL], start: byName[START] };
};

type Vars = Record<string, string | number | boolean>;

const renderCache = new Map<string, Promise<Scripts>>();
const render = (vars: Vars = {}): Promise<Scripts> => {
  const key = JSON.stringify(vars);
  let p = renderCache.get(key);
  if (!p) {
    p = runTerraformApply(import.meta.dir, { agent_id: "foo", ...vars }).then(
      collectScripts,
    );
    renderCache.set(key, p);
  }
  return p;
};

// coder-utils embeds the module's script as base64 in its wrapper. Tests that
// need a value Terraform cannot produce (such as a pinned hash matching a test
// fixture) rewrite the embedded script.
const patchEmbedded = (wrapper: string, fn: (s: string) => string) => {
  const m = wrapper.match(/echo -n '([A-Za-z0-9+/=]+)' \| base64 -d/);
  if (!m) throw new Error("no embedded script found");
  const before = Buffer.from(m[1], "base64").toString();
  const after = fn(before);
  if (after === before) throw new Error("patch changed nothing");
  return wrapper.replace(m[1], Buffer.from(after).toString("base64"));
};

const setPin = (arch: "AMD64" | "ARM64", hash: string) => (s: string) =>
  s.replace(
    new RegExp(`^PINNED_SHA256_${arch}='[0-9a-f]*'$`, "m"),
    `PINNED_SHA256_${arch}='${hash}'`,
  );

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
      DATABASE_URL: "postgres://root@127.0.0.1:26300/defaultdb?sslmode=disable",
      COCKROACH_URL:
        "postgres://root@127.0.0.1:26300/defaultdb?sslmode=disable",
      PGHOST: "127.0.0.1",
      PGPORT: "26300",
      PGUSER: "root",
      PGDATABASE: "defaultdb",
    });
  });

  it("creates install and start scripts through coder-utils", async () => {
    const state = await runTerraformApply(import.meta.dir, {
      agent_id: "foo",
    });
    const scripts = coderScripts(state);
    expect(scripts.map((s) => s.display_name).sort()).toEqual([INSTALL, START]);
    for (const s of scripts) {
      expect(s.agent_id).toBe("foo");
      expect(s.run_on_start).toBe(true);
      expect(s.start_blocks_login).toBe(false);
      expect(s.icon).toBe("/icon/cockroachdb.svg");
    }
    const { install, start } = collectScripts(state);
    expect(install).toContain(`$HOME/${MODULE_ROOT}/logs/install.log`);
    expect(start).toContain(`$HOME/${MODULE_ROOT}/logs/start.log`);
    // The start script waits for the install script.
    expect(start).toContain(
      "coder exp sync want cockroachlabs-cockroachdb-start_script cockroachlabs-cockroachdb-install_script",
    );
    expect(state.outputs.scripts.value).toEqual([
      "cockroachlabs-cockroachdb-install_script",
      "cockroachlabs-cockroachdb-start_script",
    ]);
  });
});

describe("module scripts", () => {
  let home: string;
  let stubs: string;
  let binDir: string;

  const root = () => join(home, MODULE_ROOT);
  const stateDir = () => join(root(), "state");
  const pidFile = () => join(stateDir(), "crdb.pid");
  const configFile = () => join(stateDir(), "config.env");
  const versionDir = (v: string) => join(root(), "bin", v);
  const defaultStore = () => join(root(), "data");
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
    // Host-independent libc detection; tests override these as needed.
    writeFileSync(join(stubs, "getconf"), '#!/bin/sh\necho "glibc 2.36"\n', {
      mode: 0o755,
    });
    writeFileSync(join(stubs, "ldd"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    // coder-utils orders its scripts with `coder exp sync`; record and no-op.
    writeFileSync(
      join(stubs, "coder"),
      '#!/bin/sh\necho "$@" >> "$HOME/coder.log"\nexit 0\n',
      { mode: 0o755 },
    );
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, "net"), { recursive: true });
    mkdirSync(join(home, "libc-empty"), { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(pidFile())) {
      await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`
        .nothrow()
        .quiet();
    }
    // Reap any fake cockroach whose PID file was overwritten by a test.
    await $`pkill -f ${home}/`.nothrow().quiet();
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

  const plantFakeBinary = (version: string, body = FAKE_COCKROACH) => {
    const dir = versionDir(version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cockroach"), body, { mode: 0o755 });
  };

  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    // Minimal PATH so a cockroach installed on the host can't leak in.
    PATH: `${stubs}:${binDir}:/usr/bin:/bin`,
    CODER_SCRIPT_BIN_DIR: binDir,
    READY_TIMEOUT: "1",
    // Empty fake /sys/class/net so the host's own interfaces don't leak in.
    NET_SYS_DIR: join(home, "net"),
    // Empty fake /lib so a musl installed on the host can't leak in.
    LIBC_PROBE_DIR: join(home, "libc-empty"),
    ...extra,
  });

  let scriptSeq = 0;
  const runWrapper = (script: string, e: Record<string, string>) => {
    const file = join(home, `wrapper-${scriptSeq++}.sh`);
    writeFileSync(file, script);
    return $`/bin/bash ${file}`.env(e).cwd(home).nothrow().quiet();
  };

  interface RunOpts {
    vars?: Vars;
    patch?: (s: string) => string;
  }

  // Runs the install script, then the start script, as the agent would. The
  // start script runs even when install fails: coder-utils marks install
  // complete on exit either way. coder-utils pipes each script through tee, so
  // stdout and stderr arrive merged in `out`.
  const run = async (e = env(), opts: RunOpts = {}) => {
    const s = await render(opts.vars);
    const install = opts.patch
      ? patchEmbedded(s.install, opts.patch)
      : s.install;
    const i = await runWrapper(install, e);
    const st = await runWrapper(s.start, e);
    const installOut = i.stdout.toString() + i.stderr.toString();
    const startOut = st.stdout.toString() + st.stderr.toString();
    return {
      exitCode: i.exitCode !== 0 ? i.exitCode : st.exitCode,
      installCode: i.exitCode,
      startCode: st.exitCode,
      installOut,
      startOut,
      out: installOut + startOut,
    };
  };

  const helper = (name: string, e = env(), cwd?: string) =>
    $`${join(binDir, name)}`
      .env(e)
      .cwd(cwd ?? home)
      .nothrow()
      .quiet();
  const reset = () => helper("crdb-reset");

  const setConfigStore = (p: string) =>
    writeFileSync(
      configFile(),
      readFileSync(configFile(), "utf-8").replace(
        /^STORE_PATH=.*$/m,
        `STORE_PATH='${p}'`,
      ),
    );

  it("runs the composed scripts with a store path needing quoting", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "my data", "it's $x");
    const r = await run(env(), {
      vars: { sql_port: 26300, store_path: store },
    });
    expect(r.exitCode).toBe(0);
    const args = readFileSync(join(home, "cockroach.args"), "utf-8")
      .trim()
      .split("\n");
    expect(args).toContain(`--store=${store}`);
    expect(args).toContain("--listen-addr=127.0.0.1:26300");
    expect(args).toContain("--http-addr=127.0.0.1:26080");
  });

  it("checks readiness and health over IPv4, not localhost", async () => {
    linuxAmd64();
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; case "$*" in *health*) exit 0;; esac; exit 22',
    );
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(join(home, "curl.log"), "utf-8");
    expect(calls).toContain("http://127.0.0.1:26080/health?ready=1");
    expect(calls).not.toContain("localhost");
    expect(r.out).toContain(
      "CockroachDB ready: SQL 127.0.0.1:26257 | Console http://127.0.0.1:26080",
    );
  });

  it("crdb-reset checks the console port over IPv4", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    fakeStore(defaultStore());
    stub("curl", 'echo "$@" >> "$HOME/curl.log"; exit 22');
    await reset();
    const calls = readFileSync(join(home, "curl.log"), "utf-8");
    expect(calls).toContain("http://127.0.0.1:26080/health");
    expect(calls).not.toContain("localhost");
  });

  it("lays out scripts, logs, and state under the module root", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
    expect(r.exitCode).toBe(0);
    for (const f of [
      "install.sh",
      "start.sh",
      "crdb-start",
      "crdb-reset",
      "crdb-common.sh",
    ]) {
      expect(existsSync(join(root(), "scripts", f))).toBe(true);
    }
    expect(readFileSync(join(root(), "logs/install.log"), "utf-8")).toContain(
      `Using CockroachDB ${DEFAULT_VERSION}`,
    );
    expect(readFileSync(join(root(), "logs/start.log"), "utf-8")).toContain(
      "CockroachDB ready",
    );
    expect(existsSync(join(root(), "logs/cockroach.log"))).toBe(true);
    expect(existsSync(configFile())).toBe(true);
    expect(existsSync(pidFile())).toBe(true);
    expect(readFileSync(join(home, "cockroach.args"), "utf-8")).toContain(
      `--store=${defaultStore()}`,
    );
  });

  it("does not start when the install script fails", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi');
    const r = await run();
    expect(r.installCode).not.toBe(0);
    expect(r.startCode).not.toBe(0);
    expect(r.startOut).toContain(
      `CockroachDB was not started because the install script did not finish. See ${root()}/logs/install.log.`,
    );
    expect(existsSync(pidFile())).toBe(false);
  });

  it("rejects unsupported OS", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi');
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("Unsupported OS");
  });

  it("rejects unsupported arch", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Linux; else echo mips; fi');
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("Unsupported arch");
  });

  it("rejects a relative store path", async () => {
    linuxAmd64();
    // Terraform validation rejects this first; the script checks again.
    const r = await run(env(), {
      patch: (s) =>
        s.replace(
          /^STORE_PATH=\$\(echo -n '' \| base64 -d\)$/m,
          "STORE_PATH=relstore",
        ),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("must be an absolute path");
  });

  it("links cockroach and helpers into CODER_SCRIPT_BIN_DIR", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    expect(readlinkSync(join(binDir, "cockroach"))).toBe(
      join(versionDir(DEFAULT_VERSION), "cockroach"),
    );
    for (const f of ["crdb-start", "crdb-reset"]) {
      expect(readlinkSync(join(binDir, f))).toBe(join(root(), "scripts", f));
    }
  });

  it("defaults store path to the module's data directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    expect(readFileSync(configFile(), "utf-8")).toContain(
      `STORE_PATH=${defaultStore()}`,
    );
  });

  it("is idempotent when CockroachDB is already running", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    expect(existsSync(pidFile())).toBe(true);
    const second = await run();
    expect(second.out).toContain("already running");
    expect(second.exitCode).toBe(0);
  });

  it("crdb-reset wipes the store and restarts", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    const store = defaultStore();
    writeFileSync(join(store, "CURRENT"), "MANIFEST-000001\n");
    writeFileSync(join(store, "MANIFEST-000001"), "x");
    writeFileSync(join(store, "marker"), "x");
    const firstPid = readFileSync(pidFile(), "utf-8").trim();

    await reset();

    expect(existsSync(join(store, "marker"))).toBe(false);
    expect(readFileSync(pidFile(), "utf-8").trim()).not.toBe(firstPid);
  });

  it("crdb-reset treats a process that is no longer CockroachDB as stopped", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    // On SIGTERM the process stays alive but its command line stops being a
    // CockroachDB server, as a zombie's does when PID 1 does not reap it.
    plantFakeBinary(
      DEFAULT_VERSION,
      '#!/bin/sh\n[ "$1" = version ] && exit 0\nfor a in "$@"; do case "$a" in --pid-file=*) echo $$ > "${a#--pid-file=}";; esac; done\ntrap \'exec sleep 3600\' TERM\nwhile :; do sleep 1; done\n',
    );
    await run();
    const firstPid = Number(readFileSync(pidFile(), "utf-8").trim());
    extraPids.push(firstPid);
    const store = defaultStore();
    writeFileSync(join(store, "CURRENT"), "MANIFEST-000001\n");
    writeFileSync(join(store, "MANIFEST-000001"), "x");
    writeFileSync(join(store, "marker"), "x");

    const t0 = Date.now();
    const r = await reset();

    expect(r.stderr.toString()).not.toContain("did not stop");
    expect(r.stdout.toString()).toContain("wiped");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(existsSync(join(store, "marker"))).toBe(false);
    expect(alive(firstPid)).toBe(true);
  });

  it("starts with diagnostics reporting disabled", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    expect(readFileSync(join(home, "cockroach.env"), "utf-8")).toContain(
      "COCKROACH_SKIP_ENABLING_DIAGNOSTIC_REPORTING=true",
    );
  });

  it("prints recent log lines when CockroachDB is not ready", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("Last log lines");
  });

  it("warns when host container interfaces are visible", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    mkdirSync(join(home, "net", "docker0"));
    const r = await run();
    expect(r.out).toContain("may share its host's network");
    // Warn only: CockroachDB still starts.
    expect(existsSync(pidFile())).toBe(true);
  });

  it("does not warn on a private network", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    mkdirSync(join(home, "net", "eth0"));
    const r = await run();
    expect(r.out).not.toContain("may share its host's network");
  });

  it("prefers a preinstalled cockroach and skips the download", async () => {
    linuxAmd64();
    // The readiness check also uses curl, so only flag download calls (-o).
    stub("curl", 'case "$*" in *-o*) touch "$HOME/downloaded";; esac; exit 22');
    writeFileSync(join(stubs, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
    await run();
    expect(existsSync(join(home, "downloaded"))).toBe(false);
    expect(existsSync(join(binDir, "cockroach"))).toBe(false);
    expect(readFileSync(configFile(), "utf-8")).toContain(
      join(stubs, "cockroach"),
    );
  });

  it("finds a preinstalled cockroach behind the module's own link on PATH", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *-o*) touch "$HOME/downloaded";; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    symlinkSync(
      join(versionDir(DEFAULT_VERSION), "cockroach"),
      join(binDir, "cockroach"),
    );
    const preinstalled = join(home, "image-bin");
    mkdirSync(preinstalled);
    writeFileSync(join(preinstalled, "cockroach"), FAKE_COCKROACH, {
      mode: 0o755,
    });
    // CODER_SCRIPT_BIN_DIR comes first on PATH, as it does in a workspace.
    await run(
      env({ PATH: `${stubs}:${binDir}:${preinstalled}:/usr/bin:/bin` }),
    );
    expect(existsSync(join(home, "downloaded"))).toBe(false);
    expect(readFileSync(configFile(), "utf-8")).toContain(
      `BINARY_PATH=${join(preinstalled, "cockroach")}`,
    );
  });

  it("downloads from binary_url when set", async () => {
    linuxAmd64();
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 1");
    await run(env(), {
      vars: { binary_url: "https://mirror.example/crdb/" },
    });
    expect(readFileSync(join(home, "curl.log"), "utf-8")).toContain(
      `https://mirror.example/crdb/cockroach-${DEFAULT_VERSION}.linux-amd64.tgz`,
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
    const r = await run(env(), { vars: { crdb_version: OTHER_VERSION } });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(binDir, "cockroach"))).toBe(false);
    expect(r.out).toContain("Checksum verification failed");
  });

  // A real sha256sum on the host, so pinned-hash tests compute real digests
  // (other tests stub sha256sum).
  const realSha256 = () => {
    const p = Bun.which("sha256sum");
    if (p) return `exec ${p} "$@"`;
    return 'exec shasum -a 256 "$@"';
  };

  // Serves a small tarball with the real layout through a curl stub that logs
  // its arguments. The mirror's .sha256sum matches the tarball. Returns the
  // tarball's SHA-256.
  const servePinnedFixture = async (arch = "amd64") => {
    const prefix = `cockroach-${DEFAULT_VERSION}.linux-${arch}`;
    const src = join(home, "pinned-src");
    mkdirSync(join(src, prefix), { recursive: true });
    writeFileSync(join(src, prefix, "cockroach"), FAKE_COCKROACH, {
      mode: 0o755,
    });
    const tgz = join(home, "pinned.tgz");
    await $`tar -czf ${tgz} -C ${src} ${prefix}`.quiet();
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(tgz))
      .digest("hex");
    writeFileSync(
      join(home, "pinned.tgz.sha256sum"),
      `${hash}  ${prefix}.tgz\n`,
    );
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; case "$*" in *health*) exit 0;; esac; while [ $# -gt 0 ]; do case "$1" in -o) shift; case "$1" in *.sha256sum) cp "$HOME/pinned.tgz.sha256sum" "$1";; *) cp "$HOME/pinned.tgz" "$1";; esac;; esac; shift; done',
    );
    stub("sha256sum", realSha256());
    return hash;
  };

  it("verifies against the pinned hash and never requests .sha256sum", async () => {
    linuxAmd64();
    const hash = await servePinnedFixture();
    const r = await run(env(), { patch: setPin("AMD64", hash) });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(versionDir(DEFAULT_VERSION), "cockroach"))).toBe(
      true,
    );
    const log = readFileSync(join(home, "curl.log"), "utf-8");
    expect(log).toContain(`cockroach-${DEFAULT_VERSION}.linux-amd64.tgz`);
    expect(log).not.toContain(".sha256sum");
  });

  it("fails on a pinned-hash mismatch even if the mirror's .sha256sum matches", async () => {
    linuxAmd64();
    // The fixture cannot match the real pinned hash of the default version.
    await servePinnedFixture();
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(
      `Checksum mismatch for https://binaries.cockroachdb.com/cockroach-${DEFAULT_VERSION}.linux-amd64.tgz: the file does not match the checksum pinned in this module. The mirror may be serving a modified or different file.`,
    );
    expect(existsSync(join(versionDir(DEFAULT_VERSION), "cockroach"))).toBe(
      false,
    );
    expect(existsSync(join(binDir, "cockroach"))).toBe(false);
    expect(readFileSync(join(home, "curl.log"), "utf-8")).not.toContain(
      ".sha256sum",
    );
  });

  it("uses the arm64 pin on arm64", async () => {
    stub("uname", 'if [ "$1" = "-s" ]; then echo Linux; else echo aarch64; fi');
    const hash = await servePinnedFixture("arm64");
    // The amd64 pin is wrong on purpose; only the arm64 pin applies.
    const r = await run(env(), {
      patch: (s) => setPin("ARM64", hash)(setPin("AMD64", "0".repeat(64))(s)),
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(home, "curl.log"), "utf-8")).toContain(
      "linux-arm64.tgz",
    );
    expect(existsSync(join(versionDir(DEFAULT_VERSION), "cockroach"))).toBe(
      true,
    );
  });

  it("explains a missing .sha256sum on the mirror", async () => {
    linuxAmd64();
    stub(
      "curl",
      'case "$*" in *.sha256sum*) exit 22;; esac; while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 0");
    const r = await run(env(), { vars: { crdb_version: OTHER_VERSION } });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(".sha256sum");
    expect(r.out).toContain("mirror");
  });

  it("reports ready and exits 0 when the health check passes", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("CockroachDB ready");
  });

  it("treats a PID reused by an unrelated process as stale", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const other = spawnUnrelated();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(pidFile(), String(other));
    const r = await run();
    expect(r.out).not.toContain("already running");
    expect(readFileSync(pidFile(), "utf-8").trim()).not.toBe(String(other));
    expect(alive(other)).toBe(true);
  });

  it("crdb-reset never signals an unrelated process at the PID", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    const other = spawnUnrelated();
    writeFileSync(pidFile(), String(other));
    await reset();
    expect(alive(other)).toBe(true);
  });

  it("crdb-reset refuses to wipe $HOME", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    setConfigStore(home);
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      `Refusing to wipe '${home}': that is your home directory.`,
    );
    expect(existsSync(join(home, "stubs"))).toBe(true);
  });

  it.each(["", "/state", "/logs", "/scripts", "/bin"])(
    "crdb-reset refuses a store at the module root%s",
    async (sub) => {
      linuxAmd64();
      stub("curl", "exit 22");
      plantFakeBinary(DEFAULT_VERSION);
      await run();
      setConfigStore(root() + sub);
      const r = await reset();
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("Refusing");
      expect(r.stderr.toString()).toContain(
        "overlaps the module's own directory",
      );
      expect(existsSync(join(versionDir(DEFAULT_VERSION), "cockroach"))).toBe(
        true,
      );
      expect(existsSync(configFile())).toBe(true);
    },
  );

  it("crdb-reset refuses a parent of the module root", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    setConfigStore(join(home, ".coder-modules"));
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      "overlaps the module's own directory",
    );
    expect(existsSync(configFile())).toBe(true);
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

  // Serves a tarball shaped like the real download via the curl stub. Uses
  // the non-default version so the stubbed sha256sum -c applies.
  const serveTarball = async (withLib: boolean, version = OTHER_VERSION) => {
    const prefix = `cockroach-${version}.linux-amd64`;
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
  const otherVersion = { vars: { crdb_version: OTHER_VERSION } };

  it("crdb-reset refuses an ancestor of $HOME", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    setConfigStore(dirname(home));
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("it contains your home directory.");
    expect(existsSync(join(home, "stubs"))).toBe(true);
  });

  it("crdb-reset refuses a path with .. segments", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    fakeStore(join(home, "b"));
    setConfigStore(`${home}/a/../b`);
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(home, "b", "CURRENT"))).toBe(true);
  });

  it("crdb-reset refuses a non-empty directory that is not a store", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "projects");
    mkdirSync(store);
    writeFileSync(join(store, "precious.txt"), "x");
    await run(env(), { vars: { store_path: store } });
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
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "mount point");
    fakeStore(store);
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(store)).toBe(true);
    expect(existsSync(join(store, "CURRENT"))).toBe(false);
    expect(existsSync(join(store, "000002.log"))).toBe(false);
  });

  it("crdb-reset recognizes a store that uses marker files", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "newstore");
    fakeStore(store, true);
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "MANIFEST-000001"))).toBe(false);
  });

  it("crdb-reset wipes an empty store directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
  });

  it("crdb-reset accepts a store below the module's data directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(defaultStore(), "cluster1");
    await run(env(), { vars: { store_path: store } });
    fakeStore(store);
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "CURRENT"))).toBe(false);
  });

  it("crdb-reset empties a store reached through a symlink", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const target = join(home, "crdb-target");
    const link = join(home, "crdb-link");
    fakeStore(target);
    symlinkSync(target, link);
    await run(env(), { vars: { store_path: link } });
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(target, "CURRENT"))).toBe(false);
    expect(existsSync(join(target, "000002.log"))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("crdb-reset refuses a symlink into the module directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    const link = join(home, "sneaky");
    symlinkSync(stateDir(), link);
    setConfigStore(link);
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      "overlaps the module's own directory",
    );
    expect(existsSync(configFile())).toBe(true);
  });

  it("refuses a first-start store below a symlinked parent that leads into the module directory", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    mkdirSync(stateDir(), { recursive: true });
    const link = join(home, "lnk");
    symlinkSync(stateDir(), link);
    const r = await run(env(), {
      vars: { store_path: join(link, "a", "new") },
    });
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain("overlaps the module's own directory");
    expect(existsSync(join(stateDir(), "a"))).toBe(false);
    expect(existsSync(pidFile())).toBe(false);
  });

  it("crdb-start refuses a first-start store below a symlinked parent and creates nothing", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    const link = join(home, "lnk");
    symlinkSync(stateDir(), link);
    setConfigStore(join(link, "new"));
    const r = await helper("crdb-start");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      "overlaps the module's own directory",
    );
    expect(existsSync(join(stateDir(), "new"))).toBe(false);
    expect(existsSync(pidFile())).toBe(false);
  });

  it("creates a first-start store below a symlinked parent that leads somewhere safe", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const target = join(home, "volume");
    mkdirSync(target);
    const link = join(home, "lnk");
    symlinkSync(target, link);
    const r = await run(env(), {
      vars: { store_path: join(link, "new") },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "new"))).toBe(true);
  });

  it("crdb-reset ignores and keeps lost+found", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "volume");
    mkdirSync(join(store, "lost+found"), { recursive: true });
    writeFileSync(join(store, "lost+found", "orphan"), "x");
    // Only lost+found: counts as empty.
    await run(env(), { vars: { store_path: store } });
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
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "failedstore");
    await run(env(), { vars: { store_path: store } });
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    mkdirSync(join(store, "logs"), { recursive: true });
    writeFileSync(join(store, "logs", "cockroach.log"), "x");
    mkdirSync(join(store, "cockroach-temp123"));
    writeFileSync(join(store, "temp-dirs-record.txt"), "x");
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "logs"))).toBe(false);
    expect(existsSync(join(store, "temp-dirs-record.txt"))).toBe(false);
  });

  it("crdb-reset refuses a directory holding only logs and an unrelated file", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "logsonly");
    mkdirSync(join(store, "logs"), { recursive: true });
    writeFileSync(join(store, "logs", "app.txt"), "x");
    writeFileSync(join(store, "precious"), "x");
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(store, "precious"))).toBe(true);
  });

  it("crdb-reset refuses a directory whose only entry is an unrelated logs dir", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "logsalone");
    mkdirSync(join(store, "logs"), { recursive: true });
    writeFileSync(join(store, "logs", "app.txt"), "x");
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(store, "logs", "app.txt"))).toBe(true);
  });

  it("crdb-reset accepts logs/cockroach.log as evidence of a failed start", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "logsok");
    mkdirSync(join(store, "logs"), { recursive: true });
    writeFileSync(join(store, "logs", "cockroach.log"), "x");
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "logs", "cockroach.log"))).toBe(false);
  });

  it("crdb-reset accepts a store identified by its version file", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    const store = join(home, "versioned");
    mkdirSync(store);
    writeFileSync(join(store, "COCKROACHDB_VERSION"), "x");
    writeFileSync(join(store, "other"), "x");
    await run(env(), { vars: { store_path: store } });
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    expect(existsSync(join(store, "other"))).toBe(false);
  });

  it("crdb-reset refuses to wipe a live database without a PID file", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    const store = defaultStore();
    fakeStore(store);
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    const r = await reset();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      `CockroachDB is answering on port 26080, but not as the process recorded in ${pidFile()}; stop it first.`,
    );
    expect(existsSync(join(store, "CURRENT"))).toBe(true);
  });

  it("bounds the reset health check with a curl timeout", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    const store = defaultStore();
    fakeStore(store);
    stub("curl", 'echo "$@" >> "$HOME/curl.log"; exit 22');
    const r = await reset();
    expect(r.stdout.toString()).toContain("wiped");
    const calls = readFileSync(join(home, "curl.log"), "utf-8")
      .split("\n")
      .filter((l) => l.endsWith("127.0.0.1:26080/health"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("--max-time 2");
  });

  it("crdb-reset refuses a relative store path from the config", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    setConfigStore("relstore");
    const cwd = join(home, "work");
    mkdirSync(join(cwd, "relstore"), { recursive: true });
    writeFileSync(join(cwd, "relstore", "precious"), "x");
    const r = await helper("crdb-reset", env(), cwd);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Refusing");
    expect(existsSync(join(cwd, "relstore", "precious"))).toBe(true);
  });

  it("refuses to install with the store at $HOME", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run(env(), { vars: { store_path: home } });
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain(
      `Refusing to use '${home}' as the CockroachDB store: that is your home directory.`,
    );
    expect(existsSync(pidFile())).toBe(false);
  });

  it("refuses to install with the store at an ancestor of $HOME", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run(env(), { vars: { store_path: dirname(home) } });
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain("it contains your home directory.");
    expect(existsSync(pidFile())).toBe(false);
  });

  it.each(["", "/state", "/bin"])(
    "refuses to install with the store at the module root%s",
    async (sub) => {
      linuxAmd64();
      stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
      plantFakeBinary(DEFAULT_VERSION);
      const r = await run(env(), { vars: { store_path: root() + sub } });
      expect(r.installCode).not.toBe(0);
      expect(r.out).toContain("overlaps the module's own directory");
      expect(existsSync(pidFile())).toBe(false);
    },
  );

  it("crdb-start refuses an unsafe store from the config", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    await run();
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
    setConfigStore(home);
    const r = await helper("crdb-start");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(
      `Refusing to use '${home}' as the CockroachDB store: that is your home directory.`,
    );
    expect(existsSync(pidFile())).toBe(false);
  });

  it("fails before downloading on a musl system", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", 'echo "$@" >> "$HOME/curl.log"; exit 22');
    // No glibc signal, whatever the host has.
    stub("getconf", "exit 1");
    stub("ldd", 'echo "musl libc (x86_64)" >&2; exit 1');
    const libc = join(home, "libc");
    mkdirSync(libc);
    writeFileSync(join(libc, "ld-musl-x86_64.so.1"), "");
    const r = await run(env({ LIBC_PROBE_DIR: libc }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("glibc");
    expect(existsSync(join(home, "curl.log"))).toBe(false);
  });

  it("does not mistake a glibc system with musl installed for musl", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", 'echo "$@" >> "$HOME/curl.log"; exit 22');
    stub("getconf", 'echo "glibc 2.36"');
    stub("ldd", "exit 1");
    const libc = join(home, "libc");
    mkdirSync(libc);
    writeFileSync(join(libc, "ld-musl-x86_64.so.1"), "");
    const r = await run(env({ LIBC_PROBE_DIR: libc }));
    expect(r.out).not.toContain("uses musl libc");
    // It went on to the download, which the stub fails.
    expect(r.out).toContain("Could not download");
  });

  it("recognizes glibc from ldd when getconf has no answer", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 22");
    stub("getconf", "exit 1");
    stub("ldd", 'echo "ldd (Debian GLIBC 2.36-9) 2.36"');
    const libc = join(home, "libc");
    mkdirSync(libc);
    writeFileSync(join(libc, "ld-musl-x86_64.so.1"), "");
    const r = await run(env({ LIBC_PROBE_DIR: libc }));
    expect(r.out).not.toContain("uses musl libc");
    expect(r.out).toContain("Could not download");
  });

  it("reports a disk-full download write error", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 23");
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("Could not write");
    expect(r.out).toContain("free disk space");
    expect(r.out).not.toContain("restricted networks");
  });

  it("reports a temp directory that cannot be created", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 22");
    stub("mktemp", "exit 1");
    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("temporary directory");
    expect(r.out).toContain("disk space");
  });

  // A PATH of every system tool except the named ones.
  const toolsWithout = (...omit: string[]) => {
    const tools = join(home, "tools");
    mkdirSync(tools);
    for (const dir of ["/usr/bin", "/bin"]) {
      for (const name of readdirSync(dir)) {
        if (omit.includes(name) || existsSync(join(tools, name))) continue;
        symlinkSync(join(dir, name), join(tools, name));
      }
    }
    return tools;
  };

  it.each([
    ["tar", "tar"],
    ["sha256sum", "coreutils"],
  ])("says how to fix a missing %s", async (tool, pkg) => {
    linuxAmd64();
    stub("curl", "exit 22");
    if (tool === "tar") stub("sha256sum", "exit 0");
    const r = await run(env({ PATH: `${stubs}:${toolsWithout(tool)}` }));
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain(
      `Missing required tool: ${tool}. Install it in the workspace image (for example: apt-get install -y ${pkg}), or bake cockroach into the image.`,
    );
  });

  it("says how to fix a missing curl", async () => {
    linuxAmd64();
    const r = await run(env({ PATH: `${stubs}:${toolsWithout("curl")}` }));
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain(
      "Missing required tool: curl. Install it in the workspace image (for example: apt-get install -y curl).",
    );
  });

  it("points at crdb_version and binary_url on a download HTTP error", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 22");
    const r = await run();
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain(
      "Could not download https://binaries.cockroachdb.com/cockroach-",
    );
    expect(r.out).toContain(
      "The server returned an HTTP error, so this version may not exist at binary_url. Check crdb_version and the mirror.",
    );
    expect(r.out).not.toContain("restricted networks");
  });

  it("keeps the network advice for other download failures", async () => {
    linuxAmd64();
    stub("sha256sum", "exit 0");
    stub("curl", "exit 6");
    const r = await run();
    expect(r.installCode).not.toBe(0);
    expect(r.out).toContain(
      "On restricted networks, set binary_url to an internal mirror or bake cockroach into the image.",
    );
    expect(r.out).not.toContain("HTTP error");
  });

  it("requires curl even when cockroach is preinstalled", async () => {
    linuxAmd64();
    writeFileSync(join(stubs, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
    // Every system tool except curl.
    const tools = join(home, "tools");
    mkdirSync(tools);
    for (const dir of ["/usr/bin", "/bin"]) {
      for (const name of readdirSync(dir)) {
        if (name === "curl" || existsSync(join(tools, name))) continue;
        symlinkSync(join(dir, name), join(tools, name));
      }
    }
    const r = await run(env({ PATH: `${stubs}:${tools}` }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("Missing required tool: curl");
  });

  it("does not report ready when our process has exited", async () => {
    linuxAmd64();
    // Health answers (as if another process held the port), but ours dies.
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION, "#!/bin/sh\nexit 1\n");
    const r = await run(env({ READY_TIMEOUT: "5" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain("CockroachDB ready");
    expect(r.out).toContain("exited before becoming ready");
  });

  it("does not report ready until our process writes its PID file", async () => {
    linuxAmd64();
    // Another process answers health, while our child stays alive but never
    // gets as far as writing --pid-file.
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(
      DEFAULT_VERSION,
      '#!/bin/sh\n[ "$1" = version ] && exit 0\nwhile :; do sleep 1; done\n',
    );
    const r = await run(env({ READY_TIMEOUT: "2" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain("CockroachDB ready");
    expect(r.out).toMatch(/not ready after [2-4]s/);
  });

  it("bounds readiness by elapsed time and reports it", async () => {
    linuxAmd64();
    // Each health check takes 2s (as with an unresponsive port and
    // --max-time 2), so iterations take about 3s, not 1s.
    stub("curl", 'case "$*" in *health*) sleep 2; exit 22;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const t0 = Date.now();
    const r = await run(env({ READY_TIMEOUT: "3" }));
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(7);
    const m = r.out.match(/not ready after (\d+)s/);
    expect(m).not.toBeNull();
    const reported = Number(m![1]);
    expect(reported).toBeGreaterThanOrEqual(3);
    expect(reported).toBeLessThanOrEqual(Math.ceil(elapsed) + 1);
  });

  it("bounds readiness and health checks with a curl timeout", async () => {
    linuxAmd64();
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; case "$*" in *health*) exit 0;; esac; exit 22',
    );
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
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
    const r = await run(env(), otherVersion);
    expect(r.exitCode).toBe(0);
    const ver = versionDir(OTHER_VERSION);
    expect(existsSync(join(ver, "cockroach"))).toBe(true);
    expect(readFileSync(join(ver, "lib/libgeos.so"), "utf-8")).toBe("geos");
  });

  it("installs fine when the tarball has no lib directory", async () => {
    linuxAmd64();
    await serveTarball(false);
    const r = await run(env(), otherVersion);
    expect(r.exitCode).toBe(0);
    const ver = versionDir(OTHER_VERSION);
    expect(existsSync(join(ver, "cockroach"))).toBe(true);
    expect(existsSync(join(ver, "lib"))).toBe(false);
  });

  it("extracts the tarball in a single tar pass", async () => {
    linuxAmd64();
    await serveTarball(true);
    const realTar = Bun.which("tar", { PATH: "/usr/bin:/bin" });
    stub("tar", `echo "$@" >> "$HOME/tar.log"; exec ${realTar} "$@"`);
    const r = await run(env(), otherVersion);
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(join(home, "tar.log"), "utf-8")
      .trim()
      .split("\n");
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("-xzf");
  });

  it("removes other version directories after a download", async () => {
    linuxAmd64();
    await serveTarball(true);
    const old = versionDir("v0.0.0");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "cockroach"), "old");
    mkdirSync(join(root(), "logs"), { recursive: true });
    writeFileSync(join(root(), "logs/cockroach.log"), "log\n");
    const r = await run(env(), otherVersion);
    expect(r.exitCode).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(versionDir(OTHER_VERSION), "cockroach"))).toBe(true);
    expect(
      readFileSync(join(root(), "logs/cockroach.log"), "utf-8"),
    ).toStartWith("log\n");
    expect(existsSync(configFile())).toBe(true);
    expect(existsSync(pidFile())).toBe(true);
  });

  const stopDb = async () => {
    await $`kill ${readFileSync(pidFile(), "utf-8").trim()}`.nothrow().quiet();
    rmSync(pidFile());
  };
  const installVersion = async (version: string) => {
    await serveTarball(true, version);
    const r = await run(env(), { vars: { crdb_version: version } });
    expect(r.exitCode).toBe(0);
    await stopDb();
  };
  const hasBinary = (v: string) => existsSync(join(versionDir(v), "cockroach"));
  const previous = () =>
    readFileSync(join(stateDir(), "previous_version"), "utf-8").trim();

  it("keeps the previous version after a version change", async () => {
    linuxAmd64();
    await installVersion("v0.0.1");
    expect(existsSync(join(stateDir(), "previous_version"))).toBe(false);
    await installVersion("v0.0.2");
    expect(hasBinary("v0.0.1")).toBe(true);
    expect(hasBinary("v0.0.2")).toBe(true);
    expect(previous()).toBe("v0.0.1");
  });

  it("keeps only the active and the previously active version", async () => {
    linuxAmd64();
    await installVersion("v0.0.1");
    await installVersion("v0.0.2");
    await installVersion("v0.0.3");
    expect(hasBinary("v0.0.1")).toBe(false);
    expect(hasBinary("v0.0.2")).toBe(true);
    expect(hasBinary("v0.0.3")).toBe(true);
    expect(previous()).toBe("v0.0.2");
  });

  it("rolls back to the kept version without downloading", async () => {
    linuxAmd64();
    await installVersion("v0.0.1");
    await installVersion("v0.0.2");
    stub(
      "curl",
      'echo "$@" >> "$HOME/curl.log"; case "$*" in *health*) exit 0;; esac; exit 22',
    );
    const r = await run(env(), { vars: { crdb_version: "v0.0.1" } });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(home, "curl.log"), "utf-8")).not.toContain(".tgz");
    expect(previous()).toBe("v0.0.2");
    expect(hasBinary("v0.0.2")).toBe(true);
  });

  it("does not record a version whose download failed", async () => {
    linuxAmd64();
    await installVersion("v0.0.1");
    stub("sha256sum", "exit 0");
    stub("curl", "exit 22");
    const failed = await run(env(), { vars: { crdb_version: "v0.0.2" } });
    expect(failed.installCode).not.toBe(0);
    await installVersion("v0.0.3");
    expect(hasBinary("v0.0.1")).toBe(true);
    expect(previous()).toBe("v0.0.1");
  });

  it("keeps old versions while a CockroachDB process may still use them", async () => {
    linuxAmd64();
    await serveTarball(true);
    const oldDir = versionDir("v0.0.0");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(oldDir, "cockroach"), FAKE_COCKROACH, { mode: 0o755 });
    const p = Bun.spawn(
      [
        "sh",
        join(oldDir, "cockroach"),
        "start-single-node",
        `--pid-file=${pidFile()}`,
      ],
      { stdout: "ignore", stderr: "ignore", env: { HOME: home } },
    );
    extraPids.push(p.pid);
    for (let i = 0; i < 50 && !existsSync(pidFile()); i++) await Bun.sleep(100);
    expect(existsSync(pidFile())).toBe(true);
    const r = await run(env(), otherVersion);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(versionDir(OTHER_VERSION), "cockroach"))).toBe(true);
    expect(existsSync(join(oldDir, "cockroach"))).toBe(true);
  });

  it.each(["crdb-start", "crdb-reset"])(
    "%s explains a missing config.env",
    async (name) => {
      linuxAmd64();
      stub("curl", "exit 22");
      plantFakeBinary(DEFAULT_VERSION);
      await run();
      rmSync(configFile());
      const r = await helper(name);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(
        `CockroachDB module config not found at ${configFile()}. Restart the workspace to reinstall.`,
      );
    },
  );

  it("keeps other versions when no download happens", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(DEFAULT_VERSION);
    plantFakeBinary(OTHER_VERSION);
    await run();
    expect(existsSync(join(versionDir(OTHER_VERSION), "cockroach"))).toBe(true);
  });

  it("fails fast when CockroachDB exits before becoming ready", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(
      DEFAULT_VERSION,
      '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "ERROR: address already in use" >&2\nexit 1\n',
    );
    const t0 = Date.now();
    const r = await run(env({ READY_TIMEOUT: "30" }));
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("address already in use");
    expect(r.out).toContain(
      "Another process is using port 26257 or 26080. Set sql_port / http_port in the module block.",
    );
  });

  it("does not blame the port when CockroachDB exits for another reason", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(
      DEFAULT_VERSION,
      '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "ERROR: boom" >&2\nexit 1\n',
    );
    const r = await run(env({ READY_TIMEOUT: "30" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("exited before becoming ready");
    expect(r.out).not.toContain("Another process is using port");
  });

  it("does not blame the port for a stale log line from an earlier run", async () => {
    linuxAmd64();
    stub("curl", "exit 22");
    plantFakeBinary(
      DEFAULT_VERSION,
      '#!/bin/sh\n[ "$1" = version ] && exit 0\necho "ERROR: boom" >&2\nexit 1\n',
    );
    mkdirSync(join(root(), "logs"), { recursive: true });
    writeFileSync(
      join(root(), "logs", "cockroach.log"),
      "ERROR: listen tcp 127.0.0.1:26257: address already in use\n",
    );
    const r = await run(env({ READY_TIMEOUT: "30" }));
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("exited before becoming ready");
    expect(r.out).not.toContain("Another process is using port");
  });

  it("leaves no partial binary when extraction fails", async () => {
    linuxAmd64();
    stub(
      "curl",
      'while [ $# -gt 0 ]; do case "$1" in -o) shift; : > "$1";; esac; shift; done',
    );
    stub("sha256sum", "exit 0");
    stub("tar", "exit 1");
    const r = await run(env(), otherVersion);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("disk space");
    const bin = join(versionDir(OTHER_VERSION), "cockroach");
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(`${bin}.partial`)).toBe(false);
  });

  const shellcheck = Bun.which("shellcheck");
  it.skipIf(!shellcheck)("materialized scripts pass shellcheck", async () => {
    linuxAmd64();
    stub("curl", 'case "$*" in *health*) exit 0;; esac; exit 22');
    plantFakeBinary(DEFAULT_VERSION);
    const r = await run();
    expect(r.exitCode).toBe(0);
    const dir = join(root(), "scripts");
    const files = [
      "install.sh",
      "start.sh",
      "crdb-start",
      "crdb-reset",
      "crdb-common.sh",
    ].map((f) => join(dir, f));
    const sc = await $`${shellcheck!} --severity=warning --shell=bash ${files}`
      .nothrow()
      .quiet();
    expect(sc.stdout.toString() + sc.stderr.toString()).toBe("");
    expect(sc.exitCode).toBe(0);
  });
});
