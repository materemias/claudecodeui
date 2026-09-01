import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { LLMProvider, RunningSession } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

type DetectableProvider = Extract<LLMProvider, 'claude' | 'codex' | 'omp'>;

type DetectorOptions = {
  procRoot?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
};

type OpenFile = {
  descriptorPath: string;
  target: string;
};

type DetectedLocalAgentSession = {
  provider: DetectableProvider;
  providerSessionId: string;
};

type TerminalRunningSession = Extract<RunningSession, { source: 'terminal' }>;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readLink(filePath: string): string {
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return '';
  }
}

function readDetectableProvider(value: string): DetectableProvider | null {
  if (value === 'claude' || value === 'codex' || value === 'omp') {
    return value;
  }
  return null;
}

function isInteractiveProcess(processDirectory: string): boolean {
  const stdinTarget = readLink(path.join(processDirectory, 'fd', '0'));
  return stdinTarget.startsWith('/dev/pts/') || stdinTarget.startsWith('/dev/tty');
}

function listOpenFiles(processDirectory: string): OpenFile[] {
  const descriptorDirectory = path.join(processDirectory, 'fd');
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(descriptorDirectory);
  } catch {
    return [];
  }

  const files: OpenFile[] = [];
  for (const descriptor of descriptors) {
    const descriptorPath = path.join(descriptorDirectory, descriptor);
    const target = readLink(descriptorPath);
    if (target) {
      files.push({ descriptorPath, target });
    }
  }
  return files;
}

function readProcessStartTime(processDirectory: string): string | null {
  const stat = readText(path.join(processDirectory, 'stat'));
  const closingParenthesis = stat.lastIndexOf(')');
  if (closingParenthesis < 0) {
    return null;
  }

  // Linux field 22 is item 19 after the executable name and field 3 state.
  const startTime = stat.slice(closingParenthesis + 1).trim().split(/\s+/)[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

function detectClaudeSession(
  pid: string,
  homeDirectory: string,
  processStart: string,
): DetectedLocalAgentSession | null {
  const state = readText(path.join(homeDirectory, '.claude', 'sessions', `${pid}.json`));
  if (!state) {
    return null;
  }

  try {
    const record = readObjectRecord(JSON.parse(state));
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId) {
      return null;
    }

    if (
      (typeof record.procStart !== 'string' && typeof record.procStart !== 'number')
      || processStart !== String(record.procStart)
    ) {
      return null;
    }

    return { provider: 'claude', providerSessionId: record.sessionId };
  } catch {
    return null;
  }
}

function newestOpenFile(openFiles: OpenFile[], pathFragment: string): OpenFile | null {
  let newest: OpenFile | null = null;
  let newestModifiedAt = -1;

  for (const openFile of openFiles) {
    if (!openFile.target.includes(pathFragment) || !openFile.target.endsWith('.jsonl')) {
      continue;
    }

    try {
      const modifiedAt = fs.statSync(openFile.descriptorPath).mtimeMs;
      if (modifiedAt > newestModifiedAt) {
        newest = openFile;
        newestModifiedAt = modifiedAt;
      }
    } catch {
      // The process may close a descriptor while it is being inspected.
    }
  }

  return newest;
}

function detectCodexSession(openFiles: OpenFile[]): DetectedLocalAgentSession | null {
  const rollout = newestOpenFile(openFiles, '/.codex/sessions/');
  const sessionId = rollout ? path.basename(rollout.target, '.jsonl').match(UUID_PATTERN)?.[0] : null;
  return sessionId ? { provider: 'codex', providerSessionId: sessionId } : null;
}

function ompSessionIdFromPath(filePath: string): string | null {
  const fileNameSessionId = path.basename(filePath, '.jsonl').match(UUID_PATTERN)?.[0];
  return fileNameSessionId ?? path.basename(path.dirname(filePath)).match(UUID_PATTERN)?.[0] ?? null;
}

function resumedOmpSessionId(args: string[]): string | null {
  const resumeIndex = args.indexOf('--resume');
  const resumeValue = resumeIndex >= 0
    ? args[resumeIndex + 1]
    : args.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);
  return resumeValue?.match(UUID_PATTERN)?.[0] ?? null;
}

function detectOmpSession(openFiles: OpenFile[], args: string[]): DetectedLocalAgentSession | null {
  const ompFiles = openFiles.filter(({ target }) => (
    target.includes('/.omp/agent/sessions/') && target.endsWith('.jsonl')
  ));
  const mainTranscripts = ompFiles.filter(({ target }) => UUID_PATTERN.test(path.basename(target, '.jsonl')));
  const mainSessionFile = newestOpenFile(mainTranscripts, '/.omp/agent/sessions/');
  const mainSessionId = mainSessionFile ? ompSessionIdFromPath(mainSessionFile.target) : null;
  if (mainSessionId) {
    return { provider: 'omp', providerSessionId: mainSessionId };
  }

  const resumedSessionId = resumedOmpSessionId(args);
  if (resumedSessionId) {
    return { provider: 'omp', providerSessionId: resumedSessionId };
  }

  const sidecarFile = newestOpenFile(ompFiles, '/.omp/agent/sessions/');
  const sidecarSessionId = sidecarFile ? ompSessionIdFromPath(sidecarFile.target) : null;
  return sidecarSessionId ? { provider: 'omp', providerSessionId: sidecarSessionId } : null;
}

function hasSkippedCommand(args: string[]): boolean {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === '--print'
      || arg === '-p'
      || arg.startsWith('--type=')
      || arg.startsWith('__omp_worker')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Used by this module's host scan and its process fixtures to detect interactive
 * Claude, Codex and omp sessions from Linux procfs. Other platforms fail closed.
 */
export function detectLocalAgentSessions(options: DetectorOptions = {}): DetectedLocalAgentSession[] {
  if ((options.platform ?? process.platform) !== 'linux') {
    return [];
  }

  const procRoot = options.procRoot ?? '/proc';
  const homeDirectory = options.homeDirectory ?? os.homedir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = new Map<string, DetectedLocalAgentSession>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const processDirectory = path.join(procRoot, entry.name);
    const processStart = readProcessStartTime(processDirectory);
    if (!processStart) {
      continue;
    }

    const provider = readDetectableProvider(readText(path.join(processDirectory, 'comm')).trim());
    if (!provider || !isInteractiveProcess(processDirectory)) {
      continue;
    }

    const args = readText(path.join(processDirectory, 'cmdline')).split('\0').filter(Boolean);
    if (hasSkippedCommand(args)) {
      continue;
    }

    const openFiles = provider === 'claude' ? [] : listOpenFiles(processDirectory);
    let detected: DetectedLocalAgentSession | null;
    if (provider === 'claude') {
      detected = detectClaudeSession(entry.name, homeDirectory, processStart);
    } else if (provider === 'codex') {
      detected = detectCodexSession(openFiles);
    } else {
      detected = detectOmpSession(openFiles, args);
    }

    // A reused PID can expose fields from two process generations during one scan.
    if (!detected || readProcessStartTime(processDirectory) !== processStart) {
      continue;
    }
    sessions.set(`${detected.provider}:${detected.providerSessionId}`, detected);
  }

  return [...sessions.values()];
}

const DETECTION_CACHE_TTL_MS = 2_500;
let detectionCache: { expiresAt: number; sessions: DetectedLocalAgentSession[] } | null = null;

function detectHostAgentSessions(): DetectedLocalAgentSession[] {
  const now = Date.now();
  if (detectionCache && detectionCache.expiresAt > now) {
    return detectionCache.sessions;
  }

  const sessions = detectLocalAgentSessions();
  detectionCache = { expiresAt: Date.now() + DETECTION_CACHE_TTL_MS, sessions };
  return sessions;
}

/**
 * Used by sessionsService to translate provider-native process activity to the
 * canonical, active app session rows shown in the sidebar.
 */
export const localAgentSessionsService = {
  listRunningSessions(options?: DetectorOptions): TerminalRunningSession[] {
    const detectedSessions = options ? detectLocalAgentSessions(options) : detectHostAgentSessions();
    const sessions = new Map<string, TerminalRunningSession>();

    for (const detected of detectedSessions) {
      const row = sessionsDb.getSessionByProviderSessionId(detected.providerSessionId)
        ?? sessionsDb.getSessionById(detected.providerSessionId);
      const project = row?.project_path ? projectsDb.getProjectPath(row.project_path) : null;
      if (
        !row
        || row.provider !== detected.provider
        || Boolean(row.isArchived)
        || Boolean(project?.isArchived)
      ) {
        continue;
      }

      sessions.set(row.session_id, {
        sessionId: row.session_id,
        provider: detected.provider,
        source: 'terminal',
        lastSeq: 0,
      });
    }

    return [...sessions.values()];
  },
};
