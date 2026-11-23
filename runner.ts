// runner.ts: the trial driver for mend. main.ts hands a trial over to runTrial
// when MAKEFUN_ENV_URL is set. It fetches the trial's checks from the env,
// runs main.ts on each one in a fresh directory (without MAKEFUN_ENV_URL),
// and posts the results back in batches.
//
// Protocol:
//   GET  $MAKEFUN_ENV_URL/checks    {"checks": [{"id", "argv", "stdin", "files"}], ...}
//   POST $MAKEFUN_ENV_URL/results   {"results": [{"id", "exit", "stdout", "files"}]}
//
// Node 22, standard library alone; it calls no model and needs no key.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One check: the CLI's arguments, its standard input and the files it starts with. */
export interface TrialCheck {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

/** What the CLI did on one check. */
export interface TrialResult {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

/** The CLI beside this file. */
export const MAIN_TS = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** A run longer than this is stopped and reported as exit 124. */
export const RUN_TIMEOUT_MS = 10_000;
/** The env takes at most this much stdout and this many files per result. */
export const STDOUT_LIMIT = 64 * 1024;
export const FILE_LIMIT = 64;
/** Results posted at a time, and network retries per request. */
export const POST_BATCH = 10;
export const POST_RETRIES = 4;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch again after a network error (never after an answer, whatever its status). */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= POST_RETRIES) throw err;
      await wait(250 * (attempt + 1));
    }
  }
}

/** Every regular file under `dir`, as paths relative to it with `/` separators. */
function collectFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && Object.keys(out).length < FILE_LIMIT) {
        out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

/** Run main.ts (or `program`) on one check, the way the trial expects. */
export function runOneCheck(c: TrialCheck, program: string = MAIN_TS): TrialResult {
  const dir = mkdtempSync(join(tmpdir(), 'mend-check-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [program, ...c.argv], {
      cwd: dir,
      env,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 4 * STDOUT_LIMIT,
    });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > STDOUT_LIMIT) stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    return { id: c.id, exit, stdout, files: collectFiles(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A trial: run every check of the env at `envUrl` and post its results. */
export async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const postResults = async (results: TrialResult[]): Promise<void> => {
    const res = await fetchRetry(`${base}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    const body = await res.text();
    if (!res.ok && res.status !== 409) throw new Error(`POST /results answered ${res.status}: ${body}`);
  };
  const res = await fetchRetry(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: TrialCheck[] };
  if (!Array.isArray(checks)) throw new Error('GET /checks answered without a checks array');
  let batch: TrialResult[] = [];
  for (const c of checks) {
    batch.push(runOneCheck(c));
    if (batch.length === POST_BATCH) {
      await postResults(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await postResults(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}
