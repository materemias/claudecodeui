import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-search-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
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
