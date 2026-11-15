// Token Radar — radar-5 decision-grade board.
// Driver: reads the sealed snapshot, builds the ranked board with
// lib/model.ts, and writes the graded output directory (board.json,
// data.js, dashboard/, screenshots/, dossier.json).
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MODEL,
  boardIssue,
  buildRadar,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';
import type { BoardRow, RadarData, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const SCRIPT_DIR = import.meta.dirname;
const DEFAULT_INPUT = '/input/snapshot.json';
const DEFAULT_OUTPUT = '/output';
const DOSSIER_TEXT_BYTES = 65536;
const DOSSIER_SHOT_CAP = { max: 4, max_bytes: 524288 };
const DOSSIER_DASHBOARD_CAP = { max_files: 400, max_bytes: 4194304 };

interface RunFlags {
  inputPath: string;
  outputDir: string;
}

interface WrittenOutputs {
  dossierBytes: number;
  copiedFiles: number;
}

function dossierCaps(): {
  text_max_bytes: number;
  screenshots: { max: number; max_bytes: number };
  dashboard: { max_files: number; max_bytes: number };
} {
  return {
    text_max_bytes: DOSSIER_TEXT_BYTES,
    screenshots: DOSSIER_SHOT_CAP,
    dashboard: DOSSIER_DASHBOARD_CAP,
  };
}

function parseFlags(argv: string[]): RunFlags {
  let inputPath = DEFAULT_INPUT;
  let outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--input') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--input needs a snapshot path');
      inputPath = next;
      i += 1;
    } else if (arg === '--output') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--output needs a directory');
      outputDir = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('usage: node main.ts [--input <snapshot.json>] [--output <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { inputPath, outputDir };
}

function readSnapshot(inputPath: string): Snapshot {
  const text = readFileSync(inputPath, 'utf8');
  return parseSnapshot(text);
}

function buildBoardData(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const built = buildRadar(snapshot, MODEL);
  const issue = boardIssue(built.board, snapshot);
  if (issue !== null) throw new Error(`board rejected: ${issue}`);
  if (built.board.length < 100) throw new Error(`board too small: ${built.board.length} rows`);
  return built;
}

function writeTextFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

function copyTree(sourceDir: string, targetDir: string): number {
  let copied = 0;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name);
    const to = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function writeOutputs(
  board: BoardRow[],
  radar: RadarData,
  outputDir: string,
): WrittenOutputs {
  const payload = { rows: board };
  writeTextFile(join(outputDir, 'board.json'), `${JSON.stringify(payload)}\n`);
  writeTextFile(join(outputDir, 'data.js'), dataScript(radar));
  let copied = 0;
  copied += copyTree(join(SCRIPT_DIR, 'dashboard'), join(outputDir, 'dashboard'));
  copied += copyTree(join(SCRIPT_DIR, 'screenshots'), join(outputDir, 'screenshots'));
  const dossier = buildDossier(outputDir, dossierCaps());
  writeFileSync(join(outputDir, 'dossier.json'), dossier);
  return { dossierBytes: dossier.length, copiedFiles: copied };
}

function verifyOutputs(outputDir: string, board: BoardRow[]): void {
  const onDisk = JSON.parse(
    readFileSync(join(outputDir, 'board.json'), 'utf8'),
  ) as { rows: BoardRow[] };
  if (onDisk.rows.length !== board.length) {
    throw new Error(`board.json holds ${onDisk.rows.length} rows, expected ${board.length}`);
  }
  for (let i = 0; i < board.length; i += 1) {
    if (onDisk.rows[i]?.slug !== board[i]?.slug) {
      throw new Error(`board.json row ${i + 1} is not ${board[i]?.slug}`);
    }
  }
  const rebuilt = buildDossier(outputDir, dossierCaps());
  const written = readFileSync(join(outputDir, 'dossier.json'));
  if (!Buffer.from(rebuilt).equals(written)) {
    throw new Error('dossier.json does not match a fresh buildDossier run');
  }
}

function summarize(
  board: BoardRow[],
  radar: RadarData,
  outputDir: string,
  written: WrittenOutputs,
): void {
  const top = board[0];
  const bottom = board[board.length - 1];
  const topFarmable = board.find((row) => row.plausibility === 'farmable');
  console.log(
    `token-radar radar-5: ${board.length} rows (${radar.watchlist_size} watchlist), ` +
      `top ${top?.slug} $${top?.implied_value_usd}, bottom $${bottom?.implied_value_usd}, ` +
      `top farmable ${topFarmable?.slug} #${topFarmable?.rank} $${topFarmable?.implied_value_usd} ` +
      `$${topFarmable?.total_fees_usd} fees, ` +
      `fit MAE ${radar.fit_mae}, interval coverage ${radar.interval_coverage_loo}, ` +
      `${written.copiedFiles} asset files copied, dossier ${written.dossierBytes} B -> ${outputDir}`,
  );
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const snapshot = readSnapshot(flags.inputPath);
  const built = buildBoardData(snapshot);
  const written = writeOutputs(built.board, built.radar, flags.outputDir);
  verifyOutputs(flags.outputDir, built.board);
  summarize(built.board, built.radar, flags.outputDir, written);
}

try {
  main();
} catch (error) {
  console.error(`token-radar failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
