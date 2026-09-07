import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  getOmpSessionPinsPath,
  readOmpSessionPins,
  setOmpSessionPinned,
} from '@/modules/providers/list/omp/omp-session-pins.js';

const withPinsDirectory = async (run: (pinsPath: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-omp-pins-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await run(getOmpSessionPinsPath());
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
};

test('native pins are reread after external replacement, without stale state', async () => {
  await withPinsDirectory(async (pinsPath) => {
    assert.deepEqual([...await readOmpSessionPins()], []);
    await writeFile(pinsPath, JSON.stringify(['native-one']));
    assert.deepEqual([...await readOmpSessionPins()], ['native-one']);
    await writeFile(`${pinsPath}.replacement`, JSON.stringify(['native-two']));
    await rename(`${pinsPath}.replacement`, pinsPath);
    assert.deepEqual([...await readOmpSessionPins()], ['native-two']);
    await rm(pinsPath);
    assert.deepEqual([...await readOmpSessionPins()], []);
  });
});

test('desired pin writes are idempotent and preserve unrelated native pins', async () => {
  await withPinsDirectory(async (pinsPath) => {
    await writeFile(pinsPath, JSON.stringify(['native-other']));
    assert.equal(await setOmpSessionPinned('native-target', true), true);
    assert.equal(await setOmpSessionPinned('native-target', true), true);
    assert.deepEqual(JSON.parse(await readFile(pinsPath, 'utf8')), ['native-other', 'native-target']);
    assert.equal(await setOmpSessionPinned('native-target', false), false);
    assert.equal(await setOmpSessionPinned('native-target', false), false);
    assert.deepEqual(JSON.parse(await readFile(pinsPath, 'utf8')), ['native-other']);
  });
});

test('concurrent sidebar mutations retain both requested pins', async () => {
  await withPinsDirectory(async (pinsPath) => {
    await Promise.all([
      setOmpSessionPinned('native-one', true),
      setOmpSessionPinned('native-two', true),
    ]);
    const pins: unknown = JSON.parse(await readFile(pinsPath, 'utf8'));
    assert.ok(Array.isArray(pins));
    assert.deepEqual(new Set(pins), new Set(['native-one', 'native-two']));
  });
});

test('malformed native storage is never replaced with a partial pin set', async () => {
  await withPinsDirectory(async (pinsPath) => {
    const malformed = '["native-other", 42]';
    await writeFile(pinsPath, malformed);
    await assert.rejects(readOmpSessionPins);
    await assert.rejects(() => setOmpSessionPinned('native-target', true));
    assert.equal(await readFile(pinsPath, 'utf8'), malformed);
  });
});
