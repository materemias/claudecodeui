import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { OMP_ADVISOR_SIDECAR_PATTERN } from '@/modules/providers/list/omp/omp-session-files.js';
import {
  buildCloudCliSessionName,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { ProviderSessionConfigUpdate } from '@/shared/types.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** True only when the transcript contains a provider title, not the fallback. */
  hasProviderTitle: boolean;
  /** omp's own attribution for the title: `user` for a rename, `auto` otherwise. */
  titleSource?: string;
  /** Four-word title CloudCLI generated from the first visible user message. */
  provisionalSessionName?: string;
};

const UNTITLED = 'Untitled omp Session';
const MAIN_MODEL_ROLES = new Set(['default', 'temporary', 'fallback']);
const REPLACED_MODEL_STOP_REASON = 'error';

const OMP_PARENT_SESSION_DIRECTORY_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(?:[0-9a-f]{16}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/** Background agents live somewhere below a parent session directory. */
function isBackgroundSessionFile(sessionsRoot: string, filePath: string): boolean {
  const pathParts = path.relative(sessionsRoot, filePath).split(path.sep);
  return pathParts.length >= 3
    && OMP_PARENT_SESSION_DIRECTORY_PATTERN.test(pathParts[1] ?? '');
}

/**
 * Maps `<ts>_<id>/__advisor.<name>.jsonl` back to the `<ts>_<id>.jsonl` that
 * owns it, deriving the owner the same way the history reader derives the
 * sidecar directory from a main transcript path: by the `.jsonl` suffix alone.
 * Nothing here may assume a shape for the native id — the header parser accepts
 * whatever omp wrote, and an id-shaped guard here would silently deny those
 * sessions the broadcast. An existing owning transcript is the whole condition,
 * so unrelated `__` files stay ignored.
 */
function resolveOmpSidecarParent(filePath: string): string | null {
  if (!OMP_ADVISOR_SIDECAR_PATTERN.test(path.basename(filePath))) {
    return null;
  }

  const parentTranscript = `${path.dirname(filePath)}.jsonl`;
  return fs.existsSync(parentTranscript) ? parentTranscript : null;
}

// omp asks its title model for this wrapper. A failed extraction can persist
// the opening tag by itself, so remove wrappers from auto-generated titles.
const OMP_AUTO_TITLE_WRAPPER_PATTERN = /<\/?title(?:\s[^>]*)?(?:>|$)/gi;

function normalizeOmpProviderTitle(
  title: string | undefined,
  source: string | undefined,
): string | undefined {
  if (!title || source === 'user') {
    return title;
  }
  return title.replace(OMP_AUTO_TITLE_WRAPPER_PATTERN, ' ').trim() || undefined;
}

function readProvisionalSessionName(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'message') {
    return undefined;
  }

  const message = readObjectRecord(entry.message);
  if (readOptionalString(message?.role) !== 'user') {
    return undefined;
  }

  const content = message?.content;
  if (typeof content === 'string') {
    return buildCloudCliSessionName(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    const record = readObjectRecord(part);
    if (typeof record?.text === 'string') {
      text += record.text;
    }
  }
  return text ? buildCloudCliSessionName(text) : undefined;
}

/**
 * Accumulated live-config state for one transcript, plus how much of that file
 * it already covers.
 *
 * The scan reports the LAST model in the file, so it cannot stop early: it used
 * to re-read and re-parse the whole transcript on every watcher tick — 186ms of
 * event-loop time for a live 51MB session — and `onUpdate` awaits it before the
 * `session_upserted` broadcast, which is the only channel keeping the UI in sync
 * with disk. omp only ever appends, so the state carries forward and each tick
 * folds in just the bytes appended since the previous one.
 */
type LiveConfigScan = {
  /**
   * The transcript this state was accumulated from. A path can be reused by a
   * different session, and a replacement merely longer than the old cursor
   * would otherwise be resumed into the middle of.
   */
  device: number;
  inode: number;
  /** Absolute offset one past the last newline-terminated line folded in. */
  cursor: number;
  lineNumber: number;
  lastMainModel: { line: number; value: string } | null;
  lastAssistantModel: { line: number; value: string } | null;
  liveEffort: string | null;
  prefixedModelByBareId: Map<string, string>;
};

/** Bounded so a long-lived server cannot retain state for every transcript it ever touched. */
const MAX_LIVE_CONFIG_SCANS = 256;
const liveConfigScans = new Map<string, LiveConfigScan>();
const EMPTY_LINE_CARRY = Buffer.alloc(0);

function rememberLiveConfigScan(filePath: string, scan: LiveConfigScan): void {
  // Re-inserting makes this the most recently used entry.
  liveConfigScans.delete(filePath);
  liveConfigScans.set(filePath, scan);
  for (const oldest of liveConfigScans.keys()) {
    if (liveConfigScans.size <= MAX_LIVE_CONFIG_SCANS) {
      break;
    }
    liveConfigScans.delete(oldest);
  }
}

/**
 * Folds one transcript line into the accumulating live-config state.
 *
 * Separate from the scan loop because an unterminated final record is folded
 * into a throwaway copy rather than into the state that is retained.
 */
function foldLiveConfigLine(scan: LiveConfigScan, line: string): void {
  scan.lineNumber += 1;
  let entry: Record<string, unknown> | null;
  try {
    entry = readObjectRecord(JSON.parse(line));
  } catch {
    return;
  }
  if (!entry) {
    return;
  }

  if (entry.type === 'model_change') {
    const model = readOptionalString(entry.model);
    if (!model) {
      return;
    }
    if (model.includes('/')) {
      scan.prefixedModelByBareId.set(model.slice(model.lastIndexOf('/') + 1), model);
    }
    const role = readOptionalString(entry.role);
    if (!role || MAIN_MODEL_ROLES.has(role)) {
      scan.lastMainModel = { line: scan.lineNumber, value: model };
    }
    return;
  }

  if (entry.type === 'thinking_level_change') {
    scan.liveEffort = readOptionalString(entry.level)
      ?? readOptionalString(entry.thinking)
      ?? readOptionalString(entry.value)
      ?? scan.liveEffort;
    return;
  }

  if (entry.type !== 'message') {
    return;
  }
  const message = readObjectRecord(entry.message);
  const model = readOptionalString(message?.model);
  if (
    message?.role === 'assistant'
    && model
    && readOptionalString(message.stopReason) !== REPLACED_MODEL_STOP_REASON
  ) {
    scan.lastAssistantModel = { line: scan.lineNumber, value: model };
  }
}

/**
 * Folds every newline-terminated line in `[start, end)`, returning the offset
 * one past the last complete line plus any trailing fragment.
 *
 * Offsets are counted from raw bytes rather than from decoded line lengths, so
 * a resume point cannot drift. The fragment — the watcher does observe the file
 * mid-append — is neither folded nor counted here, so the next pass reads it
 * again once it is complete.
 */
async function foldTranscriptLines(
  filePath: string,
  start: number,
  end: number,
  fold: (line: string) => void,
): Promise<{ cursor: number; trailing: string }> {
  let cursor = start;
  let carry: Buffer<ArrayBufferLike> = EMPTY_LINE_CARRY;
  const stream = fs.createReadStream(filePath, { start, end: end - 1 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let from = 0;
      let newline = buffer.indexOf(0x0a, from);
      while (newline !== -1) {
        fold(buffer.toString('utf8', from, newline));
        cursor += newline - from + 1;
        from = newline + 1;
        newline = buffer.indexOf(0x0a, from);
      }
      carry = from < buffer.length ? buffer.subarray(from) : EMPTY_LINE_CARRY;
    }
  } finally {
    stream.destroy();
  }
  return { cursor, trailing: carry.length > 0 ? carry.toString('utf8') : '' };
}

/**
 * Session indexer for omp ACP transcripts.
 *
 * omp persists each session as `~/.omp/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`.
 * agent.db has NO sessions table, so the jsonl store is the source of truth
 * (Claude-style scan, not the Hermes SQLite one). The `type:'session'` header
 * carries `{id, cwd, timestamp}`, a `type:'title'` entry carries the provider
 * title, and the first visible user message supplies CloudCLI's provisional title.
 */
export class OmpSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'omp' as const;
  private readonly sessionsRoot = path.join(os.homedir(), '.omp', 'agent', 'sessions');

  async synchronize(since?: Date): Promise<number> {
    if (!fs.existsSync(this.sessionsRoot)) {
      return 0;
    }
    const files = await findFilesRecursivelyCreatedAfter(this.sessionsRoot, '.jsonl', since ?? null);

    let processed = 0;
    // Owners already synchronized by this scan. A sidecar is not a session; it
    // stands in for the transcript that owns it, and this scan usually reaches
    // that transcript directly as well. Resolving without deduplicating would
    // re-synchronize an owner once per sidecar it owns — the whole per-file
    // scan, multiplied, on the one path that walks every file under the root.
    // Skipping sidecars outright would be cheaper still, but an incremental
    // scan only sees files born since its cursor, so a new sidecar is the one
    // thing that can bring an older, not-yet-indexed owner back into view.
    const synchronizedOwners = new Set<string>();
    for (const filePath of files) {
      const owner = path.basename(filePath).startsWith('__')
        ? resolveOmpSidecarParent(filePath)
        : filePath;
      if (!owner || synchronizedOwners.has(owner)) {
        continue;
      }
      synchronizedOwners.add(owner);
      if (await this.synchronizeFile(owner, since === undefined)) {
        processed += 1;
      }
    }
    return processed;
  }

  async synchronizeFile(filePath: string, preserveArchived = false): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    if (path.basename(filePath).startsWith('__')) {
      // A sidecar is never a session of its own, but `readNormalizedOmpHistory`
      // folds its advisor notes into the owning transcript, so its content is
      // part of that session's history. Index the owner instead. The watcher
      // drops any event whose sync reported nothing indexed, so returning null
      // here left a turn that wrote only advisor output with no
      // `session_upserted`, and an open chat never learned that the history it
      // was showing had changed.
      const parentTranscript = resolveOmpSidecarParent(filePath);
      return parentTranscript
        ? this.synchronizeFile(parentTranscript, preserveArchived)
        : null;
    }

    const parsed = await this.parseSessionHeader(filePath);
    if (!parsed) {
      return null;
    }

    // omp keeps the CURRENT title on the `type:'title'` header it rewrites in
    // place (that entry's `pad` field is a fixed-width slot for exactly this), so
    // every watcher tick reads the live title, and a retitle mid-session shows up
    // here. Which name wins is the question, and there are two owners: omp and
    // the user renaming the session in CloudCLI.
    //
    // `provider_name` is the last title read out of the jsonl. A stored name
    // that differs from that watermark is a local rename, except for the
    // provisional four-word name CloudCLI generated before omp wrote a title.
    // The synchronizer recognizes that provisional name from the first user
    // message, so existing app-created sessions can adopt omp's canonical title
    // without allowing later app renames to be overwritten by auto-retitles.
    // A NULL watermark still means "origin unknown" for provider-indexed rows.
    //
    // App-created rows key session_id=app-id, provider_session_id=native-id, so
    // look up by provider id first; the DB upsert also refuses to overwrite their
    // name, which is why an adopted title is written through updateSessionCustomName.
    const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const currentTitle = parsed.sessionName;
    const watermark = existing?.provider_name ?? null;
    const storedName = existing?.custom_name ?? null;
    const storedNameSource = existing?.name_source ?? null;
    const isAppCreatedSession = existing !== null
      && existing.session_id !== existing.provider_session_id;
    const hasProvisionalAppName = isAppCreatedSession
      && (storedNameSource === 'provisional'
        || (storedNameSource === null
          && storedName !== null
          && storedName === parsed.provisionalSessionName));
    const providerTitleMoved = Boolean(currentTitle) && currentTitle !== watermark;
    const nameFollowsProviderTitle = storedNameSource === 'provider'
      || (storedNameSource === null
        && (!storedName || storedName === UNTITLED || storedName === watermark));
    const adoptProviderTitle = parsed.hasProviderTitle
      && Boolean(currentTitle)
      && currentTitle !== storedName
      && (hasProvisionalAppName
        || (providerTitleMoved && (parsed.titleSource === 'user' || nameFollowsProviderTitle)));

    let nameToPersist = currentTitle;
    if (storedName && storedName !== UNTITLED) {
      nameToPersist = storedName;
    }

    const timestamps = await readFileTimestamps(filePath);
    const rowSessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      nameToPersist,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      {
        isOneShot: isBackgroundSessionFile(this.sessionsRoot, filePath),
        preserveArchived,
      },
    );

    if (parsed.hasProviderTitle && currentTitle) {
      if (adoptProviderTitle) {
        sessionsDb.updateSessionCustomName(rowSessionId, currentTitle, 'provider');
      }
      if (currentTitle !== watermark) {
        sessionsDb.updateSessionProviderName(rowSessionId, currentTitle);
      }
    }

    const liveConfig = await this.deriveLiveConfig(filePath);
    if (liveConfig.length > 0) {
      sessionsDb.applySessionConfigReport(rowSessionId, {
        source: 'live',
        updates: liveConfig,
      });
    }
    return rowSessionId;
  }

  /**
   * Scans until the session metadata, provider title, and first visible user
   * message have all been found. They sit near the top in practice.
   */
  private async parseSessionHeader(filePath: string): Promise<ParsedSession | null> {
    // <ts>_<id>.jsonl → the id is the last '_'-delimited segment (the ISO ts
    // uses '-', so it never contains '_'). Used only as a fallback for id.
    const idFromName = path.basename(filePath, '.jsonl').split('_').pop() || '';

    let sessionId: string | undefined;
    let projectPath: string | undefined;
    let title: string | undefined;
    let hasProviderTitle = false;
    let titleSource: string | undefined;
    let provisionalSessionName: string | undefined;

    // Keep a handle on the stream: `rl.close()` does NOT destroy its input, so the
    // early `break` below would leak the fd until GC — once per watcher tick, per
    // session file.
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let entry: Record<string, unknown> | null;
        try {
          entry = readObjectRecord(JSON.parse(trimmed));
        } catch {
          continue; // partial/malformed trailing line
        }
        if (!entry) {
          continue;
        }
        provisionalSessionName ??= readProvisionalSessionName(entry);
        if (entry.type === 'session') {
          sessionId = readOptionalString(entry.id) ?? sessionId;
          projectPath = readOptionalString(entry.cwd) ?? projectPath;
          const entryTitle = readOptionalString(entry.title);
          if (!title && entryTitle) {
            const entrySource = readOptionalString(entry.titleSource);
            hasProviderTitle = true;
            title = normalizeOmpProviderTitle(entryTitle, entrySource);
            titleSource = entrySource;
          }
        } else if (entry.type === 'title' || entry.type === 'title_change') {
          const entryTitle = readOptionalString(entry.title);
          if (entryTitle) {
            const entrySource = readOptionalString(entry.source);
            hasProviderTitle = true;
            title = normalizeOmpProviderTitle(entryTitle, entrySource);
            // `source` is omp's attribution, and it travels with the title it
            // describes: read it from the same entry, never from a later one.
            titleSource = entrySource;
          }
        }
        if (sessionId && projectPath && title && provisionalSessionName) {
          break;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    const resolvedId = sessionId ?? (idFromName || undefined);
    if (!resolvedId || !projectPath) {
      return null; // without a cwd we can't attribute the session to a project
    }
    return {
      sessionId: resolvedId,
      projectPath,
      sessionName: normalizeSessionName(
        title,
        hasProviderTitle ? (provisionalSessionName ?? UNTITLED) : UNTITLED,
      ),
      hasProviderTitle,
      titleSource,
      provisionalSessionName,
    };
  }

  /**
   * Derives the latest main-model and thinking-level reports from OMP history.
   *
   * Role-specific model bindings are not the session's active model. Assistant
   * records fill the gap when a terminal switch writes only a bare model id.
   * Failed attempts are skipped because OMP may replace them with a fallback in
   * the same turn.
   */
  private async deriveLiveConfig(filePath: string): Promise<ProviderSessionConfigUpdate[]> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      return [];
    }

    // Carrying state forward requires both that this is still the same file and
    // that it only grew. A shorter file is a different session on the same path;
    // so is a same-or-longer one with a different inode, which a length check
    // alone would happily resume into the middle of.
    const previous = liveConfigScans.get(filePath);
    const resumable = previous
      && previous.device === stats.dev
      && previous.inode === stats.ino
      && previous.cursor <= stats.size
      ? previous
      : null;
    // Folded into a copy: a read that throws partway must leave the retained
    // state exactly as it was rather than half-advanced.
    const scan: LiveConfigScan = resumable
      ? { ...resumable, prefixedModelByBareId: new Map(resumable.prefixedModelByBareId) }
      : {
        device: stats.dev,
        inode: stats.ino,
        cursor: 0,
        lineNumber: 0,
        lastMainModel: null,
        lastAssistantModel: null,
        liveEffort: null,
        prefixedModelByBareId: new Map(),
      };

    let trailing = '';
    if (scan.cursor < stats.size) {
      try {
        const folded = await foldTranscriptLines(
          filePath,
          scan.cursor,
          stats.size,
          (line) => foldLiveConfigLine(scan, line),
        );
        scan.cursor = folded.cursor;
        trailing = folded.trailing;
      } catch {
        return [];
      }
    }

    rememberLiveConfigScan(filePath, scan);

    // omp terminates every record with a newline, but a complete final record
    // left without one is still current state, and the previous full-file
    // reader reported it. Fold it into a throwaway copy so this answer reflects
    // it while the retained cursor stays behind it — the next append re-reads
    // those bytes as part of the finished line, folding it exactly once.
    const answer = trailing
      ? { ...scan, prefixedModelByBareId: new Map(scan.prefixedModelByBareId) }
      : scan;
    if (trailing) {
      foldLiveConfigLine(answer, trailing);
    }

    const latestModel = answer.lastMainModel && answer.lastAssistantModel
      ? (answer.lastMainModel.line > answer.lastAssistantModel.line
        ? answer.lastMainModel.value
        : answer.lastAssistantModel.value)
      : (answer.lastMainModel?.value ?? answer.lastAssistantModel?.value ?? null);
    const liveModel = latestModel?.includes('/')
      ? latestModel
      : (latestModel ? answer.prefixedModelByBareId.get(latestModel) ?? null : null);
    return [
      ...(liveModel ? [{ field: 'model' as const, value: liveModel }] : []),
      ...(answer.liveEffort ? [{ field: 'effort' as const, value: answer.liveEffort }] : []),
    ];
  }
}
