import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type NativeLock = { acquired: boolean; release: () => void };

// Load the platform N-API entry directly: OMP's top-level loader uses Bun's
// import.meta.dir. The platform entry supports Node and owns the same OS lock.
const nativeRequire = createRequire(import.meta.resolve('@oh-my-pi/pi-natives'));

function acquireNativeLock(lockPath: string): NativeLock {
  const binding: unknown = nativeRequire(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`);
  if (typeof binding !== 'object' || binding === null || !('FileLock' in binding)) {
    throw new Error('OMP native binding does not expose FileLock');
  }
  const factory = binding.FileLock;
  if (typeof factory !== 'function' || !('tryAcquire' in factory) || typeof factory.tryAcquire !== 'function') {
    throw new Error('OMP native FileLock does not support tryAcquire');
  }
  const handle: unknown = factory.tryAcquire(lockPath);
  if (
    typeof handle !== 'object' || handle === null
    || !('acquired' in handle) || typeof handle.acquired !== 'boolean'
    || !('release' in handle) || typeof handle.release !== 'function'
  ) {
    throw new Error('OMP native FileLock returned an invalid lock handle');
  }
  return { acquired: handle.acquired, release: handle.release.bind(handle) };
}

/** Used by provider star storage and its watcher to address OMP's canonical pin registry. */
export function getOmpSessionPinsPath(): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
  return path.resolve(agentDirectory, 'session-pins.json');
}

async function readPins(filePath: string): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
  const decoded: unknown = JSON.parse(content);
  if (!Array.isArray(decoded) || !decoded.every((id: unknown) => typeof id === 'string')) {
    throw new Error('OMP session-pins.json must contain an array of session IDs');
  }
  return new Set(decoded);
}

/** Used by provider starred lists/search; rereads native pins so external /pin changes are authoritative. */
export async function readOmpSessionPins(): Promise<ReadonlySet<string>> {
  return readPins(getOmpSessionPinsPath());
}

async function replacePinsFile(temporaryPath: string, filePath: string): Promise<void> {
  try {
    await rename(temporaryPath, filePath);
    return;
  } catch (error) {
    if (
      process.platform !== 'win32' || !(error instanceof Error) || !('code' in error)
      || (error.code !== 'EPERM' && error.code !== 'EEXIST')
    ) {
      throw error;
    }
  }

  // Keep the old file recoverable until the new one is installed, and restore
  // it if installation fails.
  const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
  await rename(filePath, backupPath);
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rename(backupPath, filePath);
    throw error;
  }
  await rm(backupPath, { force: true });
}

/** Used by the provider star service. Serializes cooperating CloudCLI writers and retains unrelated pins. */
export async function setOmpSessionPinned(nativeSessionId: string, desiredState?: boolean): Promise<boolean> {
  const filePath = getOmpSessionPinsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  // Match the native lock helper's identity. OMP 18.1.13's /pin does not take
  // this lock, so simultaneous TUI and CloudCLI changes remain last-writer-wins.
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lock = acquireNativeLock(lockPath);
    if (!lock.acquired) {
      lock.release();
      if (attempt < 49) await delay(100);
      continue;
    }
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const pins = await readPins(filePath);
      const isPinned = pins.has(nativeSessionId);
      const nextState = desiredState ?? !isPinned;
      if (isPinned === nextState) return nextState;
      if (nextState) pins.add(nativeSessionId);
      else pins.delete(nativeSessionId);
      await writeFile(temporaryPath, JSON.stringify([...pins], null, '\t'), { mode: 0o600, flag: 'wx' });
      await replacePinsFile(temporaryPath, filePath);
      return nextState;
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } finally {
        lock.release();
      }
    }
  }
  throw new Error('Timed out waiting for the OMP session pin lock');
}
