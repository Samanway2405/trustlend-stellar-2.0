/**
 * Regression tests for scripts/backup.sh.
 *
 * These run the real script under bash with stubbed `pg_dump`, `pg_restore` and
 * `aws` binaries injected on PATH, so the whole pipeline is exercised without a
 * database or AWS account.
 *
 * Each case pins a bug the original script actually shipped with:
 *   - it aborted in CI because it unconditionally sourced a .env that is not
 *     committed, so no backup was ever produced;
 *   - it dumped with --schema-only, backing up no data;
 *   - "cleanup" deleted the encrypted file and left the plaintext dump behind;
 *   - it encrypted with OpenSSL's deprecated KDF and passed the key on the
 *     command line, where the process list exposes it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/backup.sh");

/** The suite needs a POSIX shell plus the tools the script itself shells out to. */
function toolingAvailable(): boolean {
  for (const tool of ["bash", "openssl", "sha256sum"]) {
    const probe = spawnSync("bash", ["-lc", `command -v ${tool}`], { encoding: "utf8" });
    if (probe.status !== 0) return false;
  }
  return true;
}

const HAS_TOOLING = toolingAvailable();
const describeShell = HAS_TOOLING ? describe : describe.skip;

let root: string;
let stubDir: string;

/** Write an executable stub that shadows a real binary on PATH. */
function writeStub(name: string, body: string) {
  const file = join(stubDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** A pg_dump that writes `bytes` of deterministic content to its --file target. */
function stubPgDump(bytes: number) {
  writeStub(
    "pg_dump",
    [
      'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}";; esac; done',
      `head -c ${bytes} /dev/zero | tr '\\0' 'x' > "$out"`,
    ].join("\n"),
  );
}

function runBackup(env: Record<string, string>, cwd: string) {
  return spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      ...env,
    },
  });
}

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  BACKUP_ENCRYPTION_KEY: "correct-horse-battery-staple",
  S3_BUCKET: "trustlend-backups-test",
};

beforeAll(() => {
  if (!HAS_TOOLING) return;
  root = mkdtempSync(join(tmpdir(), "backup-test-"));
  stubDir = join(root, "bin");
  mkdirSync(stubDir);
  // Default stubs; individual tests override them.
  stubPgDump(4096);
  writeStub("pg_restore", "exit 0");
  writeStub("aws", "exit 0");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describeShell("scripts/backup.sh", () => {
  it("is executed with a real bash available", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  describe("configuration validation", () => {
    it.each(["DATABASE_URL", "BACKUP_ENCRYPTION_KEY", "S3_BUCKET"])(
      "fails loudly when %s is missing",
      (missing) => {
        const workdir = mkdtempSync(join(root, "run-"));
        const env = { ...VALID_ENV, BACKUP_DRY_RUN: "1" } as Record<string, string>;
        delete env[missing];
        // Blank rather than absent, so the parent process env cannot leak in.
        env[missing] = "";

        const result = runBackup(env, workdir);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(missing);
      },
    );

    it("runs without a .env file present, as it does in CI", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      expect(existsSync(join(workdir, ".env"))).toBe(false);
      stubPgDump(4096);

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).toBe(0);
    });

    it("still reads a .env file when one exists, for local runs", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      writeFileSync(
        join(workdir, ".env"),
        [
          `DATABASE_URL=${VALID_ENV.DATABASE_URL}`,
          `BACKUP_ENCRYPTION_KEY=${VALID_ENV.BACKUP_ENCRYPTION_KEY}`,
          `S3_BUCKET=${VALID_ENV.S3_BUCKET}`,
        ].join("\n"),
      );
      stubPgDump(4096);

      const result = runBackup({ BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).toBe(0);
    });
  });

  describe("dump integrity", () => {
    it("refuses to upload an empty dump", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(0);

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Refusing to upload/i);
    });

    it("refuses to upload a truncated dump below the minimum size", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(16);

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Refusing to upload/i);
    });

    it("refuses a dump that pg_restore cannot parse", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(4096);
      writeStub("pg_restore", 'echo "did not find magic string" >&2; exit 1');

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/pg_restore validation/i);

      writeStub("pg_restore", "exit 0");
    });

    it("requests a full dump, never --schema-only", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      const argsFile = join(workdir, "dump-args.txt");
      writeStub(
        "pg_dump",
        [
          `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
          'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}";; esac; done',
          `head -c 4096 /dev/zero | tr '\\0' 'x' > "$out"`,
        ].join("\n"),
      );

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).toBe(0);
      const args = readFileSync(argsFile, "utf8");
      expect(args).not.toContain("--schema-only");
      expect(args).toContain("--format=custom");

      stubPgDump(4096);
    });
  });

  describe("secret hygiene", () => {
    it("leaves no plaintext dump behind on success", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(4096);

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).toBe(0);
      expect(readdirSync(workdir)).toEqual([]);
    });

    it("leaves no plaintext dump behind when the run fails", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(4096);
      writeStub("pg_restore", "exit 1");

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).not.toBe(0);
      expect(readdirSync(workdir)).toEqual([]);

      writeStub("pg_restore", "exit 0");
    });

    it("does not pass the encryption key as a command-line argument", () => {
      // `-k <key>` would expose the passphrase in the process list to any other
      // user on the host; the script must use `-pass env:` instead.
      const source = readFileSync(SCRIPT, "utf8");
      expect(source).toContain("-pass env:BACKUP_ENCRYPTION_KEY");
      expect(source).not.toMatch(/openssl enc[^\n]*-k\s+\$/);
    });

    it("encrypts with PBKDF2 rather than OpenSSL's deprecated default KDF", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      stubPgDump(4096);

      const result = runBackup({ ...VALID_ENV, BACKUP_DRY_RUN: "1" }, workdir);

      expect(result.status).toBe(0);
      // OpenSSL prints this to stderr whenever the legacy KDF is used.
      expect(result.stderr).not.toMatch(/deprecated key derivation/i);
    });
  });

  describe("encryption", () => {
    it("uploads ciphertext that round-trips with the key and fails without it", () => {
      const workdir = mkdtempSync(join(root, "run-"));
      const uploaded = join(workdir, "uploaded.enc");
      stubPgDump(4096);
      // Capture what would go to S3, and answer the verification calls.
      writeStub(
        "aws",
        [
          'case "$1 $2" in',
          `  "s3 cp") cp "$3" ${JSON.stringify(uploaded)} ;;`,
          `  "s3api head-object") wc -c < ${JSON.stringify(uploaded)} | tr -d ' ' ;;`,
          '  "s3api list-objects-v2") printf "" ;;',
          "esac",
        ].join("\n"),
      );

      const result = runBackup(VALID_ENV, workdir);
      expect(result.status).toBe(0);
      expect(existsSync(uploaded)).toBe(true);

      const decrypt = (key: string) =>
        spawnSync(
          "bash",
          [
            "-c",
            'openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha512 ' +
              `-in ${JSON.stringify(uploaded)} -pass env:KEY`,
          ],
          { encoding: "utf8", env: { ...process.env, KEY: key } },
        );

      const good = decrypt(VALID_ENV.BACKUP_ENCRYPTION_KEY);
      expect(good.status).toBe(0);
      expect(good.stdout.length).toBe(4096);

      const bad = decrypt("not-the-right-key");
      expect(bad.status).not.toBe(0);

      writeStub("aws", "exit 0");
    });
  });
});
