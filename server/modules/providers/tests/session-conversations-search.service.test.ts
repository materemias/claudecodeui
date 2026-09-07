import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const environmentKeys = ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR'];
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-search-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = tempDirectory;
  process.env.USERPROFILE = tempDirectory;
  process.env.PI_CODING_AGENT_DIR = path.join(tempDirectory, 'agent');

  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('starred conversation search filters before its result limit', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const sessionIds = Array.from({ length: 51 }, (_, index) => `search-session-${index}`);
    for (const [index, sessionId] of sessionIds.entries()) {
      const timestamp = new Date(Date.UTC(2020, 0, index + 1)).toISOString();
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/workspace/search-project',
        `Needle session ${index}`,
        timestamp,
        timestamp,
      );
    }

    const starredSessionId = sessionIds[0];
    sessionsDb.updateSessionIsStarred(starredSessionId, true);

    const result = await searchConversations('needle', 1, null, null, null, true);


    assert.deepEqual(result.titleResults.map((session) => session.sessionId), [starredSessionId]);
  });
});
