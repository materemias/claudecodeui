import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type StarFixture = { baseUrl: string; directory: string; pinsPath: string };

async function withStarServer(run: (fixture: StarFixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-stars-'));
  const environmentKeys = ['DATABASE_PATH', 'HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR'];
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  let server: Server | undefined;

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  process.env.HOME = path.join(directory, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = path.join(directory, 'agent');

  try {
    await mkdir(process.env.HOME, { recursive: true });
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    // Load native/provider modules only after HOME is isolated: the registry
    // captures provider directories when its synchronizers are constructed.
    const { getOmpSessionPinsPath } = await import('@/modules/providers/list/omp/omp-session-pins.js');
    const { default: providerRouter } = await import('@/modules/providers/provider.routes.js');
    const app = express().use(express.json()).use('/api/providers', providerRouter);
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: { code: error.code } });
        return;
      }
      res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const pinsPath = getOmpSessionPinsPath();
    assert.ok(pinsPath.startsWith(`${directory}${path.sep}`));
    await mkdir(path.dirname(pinsPath), { recursive: true });
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, directory, pinsPath });
  } finally {
    const listeningServer = server;
    if (listeningServer) {
      await new Promise<void>((resolve, reject) => {
        listeningServer.close((error) => error ? reject(error) : resolve());
      });
    }
    closeConnection();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
}

async function getStars(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/providers/sessions/starred`);
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assertRecord(payload);
  assertRecord(payload.data);
  assert.ok(Array.isArray(payload.data.sessions));
  return payload.data.sessions.map((session: unknown) => {
    assertRecord(session);
    const { sessionId, sessionTitle, projectDisplayName, isArchived, isProjectArchived, isOneShot, lastActivity } = session;
    assert.ok(typeof sessionId === 'string' && typeof sessionTitle === 'string' && typeof projectDisplayName === 'string');
    assert.ok(typeof isArchived === 'boolean' && typeof isProjectArchived === 'boolean' && typeof isOneShot === 'boolean');
    assert.ok(lastActivity === null || typeof lastActivity === 'string');
    return { sessionId, sessionTitle, projectDisplayName, isArchived, isProjectArchived, isOneShot, lastActivity };
  });
}

async function writeStar(baseUrl: string, sessionId: string, isStarred?: boolean) {
  const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/toggle-star`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isStarred }),
  });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assertRecord(payload);
  assertRecord(payload.data);
  const data = payload.data;
  assert.ok(typeof data.sessionId === 'string' && typeof data.isStarred === 'boolean');
  return { sessionId: data.sessionId, isStarred: data.isStarred };
}

test('star writes reject missing or unknown session ids asynchronously', async () => {
  await withStarServer(async () => {
    // The writer's native adapter must first load under the fixture HOME.
    const { toggleSessionStar } = await import('@/modules/providers/services/session-star.service.js');
    await assert.rejects(() => toggleSessionStar('   '), (error: unknown) =>
      error instanceof AppError && error.code === 'SESSION_ID_REQUIRED' && error.statusCode === 400);
    await assert.rejects(() => toggleSessionStar('missing-session'), (error: unknown) =>
      error instanceof AppError && error.code === 'SESSION_NOT_FOUND' && error.statusCode === 404);
  });
});

test('native pins and API stars share provider ids without importing or mirroring SQLite flags', async () => {
  await withStarServer(async ({ baseUrl, directory, pinsPath }) => {
    const nativeId = '00000000-0000-4000-8000-000000000001';
    const unknownId = '00000000-0000-4000-8000-000000000002';
    const fallbackId = '00000000-0000-4000-8000-000000000003';
    const workspace = path.join(directory, 'workspace');
    sessionsDb.createAppSession('app-omp', 'omp', workspace, 'Mapped OMP session');
    sessionsDb.assignProviderSessionId('app-omp', nativeId);
    sessionsDb.createSession('stale-omp', 'omp', workspace, 'Stale SQLite star');
    sessionsDb.updateSessionIsStarred('stale-omp', true);
    sessionsDb.createAppSession('app-claude', 'claude', workspace, 'Claude star');
    sessionsDb.assignProviderSessionId('app-claude', 'native-claude');
    sessionsDb.updateSessionIsStarred('app-claude', true);
    sessionsDb.createAppSession(fallbackId, 'omp', workspace, 'Unmapped OMP session');

    await writeFile(pinsPath, JSON.stringify([nativeId, unknownId]));
    assert.deepEqual((await getStars(baseUrl)).map((row) => row.sessionId).sort(), ['app-claude', 'app-omp']);
    assert.equal(sessionsDb.getSessionById('app-omp')?.isStarred, 0);

    assert.deepEqual(await writeStar(baseUrl, 'app-omp', false), { sessionId: 'app-omp', isStarred: false });
    assert.deepEqual(await writeStar(baseUrl, 'app-omp', false), { sessionId: 'app-omp', isStarred: false });
    assert.deepEqual(JSON.parse(await readFile(pinsPath, 'utf8')), [unknownId]);
    assert.deepEqual((await getStars(baseUrl)).map((row) => row.sessionId), ['app-claude']);

    assert.deepEqual(await writeStar(baseUrl, nativeId, true), { sessionId: 'app-omp', isStarred: true });
    assert.deepEqual(await writeStar(baseUrl, nativeId, true), { sessionId: 'app-omp', isStarred: true });
    assert.deepEqual(new Set(JSON.parse(await readFile(pinsPath, 'utf8'))), new Set([nativeId, unknownId]));
    assert.deepEqual(await writeStar(baseUrl, nativeId), { sessionId: 'app-omp', isStarred: false });
    assert.deepEqual(await writeStar(baseUrl, nativeId), { sessionId: 'app-omp', isStarred: true });
    assert.equal(sessionsDb.getSessionById('app-omp')?.isStarred, 0);
    assert.equal(sessionsDb.getSessionById('stale-omp')?.isStarred, 1);

    const pendingWrite = await fetch(`${baseUrl}/api/providers/sessions/${fallbackId}/toggle-star`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isStarred: true }),
    });
    assert.equal(pendingWrite.status, 409);
    assert.deepEqual(await pendingWrite.json(), { error: { code: 'OMP_SESSION_NOT_STARTED' } });
    assert.equal(JSON.parse(await readFile(pinsPath, 'utf8')).includes(fallbackId), false);
    const assignedNativeId = '00000000-0000-4000-8000-000000000004';
    sessionsDb.assignProviderSessionId(fallbackId, assignedNativeId);
    assert.deepEqual(await writeStar(baseUrl, fallbackId, true), { sessionId: fallbackId, isStarred: true });
    assert.ok((await getStars(baseUrl)).some((row) => row.sessionId === fallbackId));
    await writeStar(baseUrl, fallbackId, false);

    const nativePinsBeforeOtherProviderWrites = await readFile(pinsPath, 'utf8');
    assert.deepEqual(await writeStar(baseUrl, 'native-claude', false), { sessionId: 'app-claude', isStarred: false });
    await writeStar(baseUrl, 'native-claude', false);
    assert.equal(sessionsDb.getSessionById('app-claude')?.isStarred, 0);
    assert.deepEqual(await writeStar(baseUrl, 'native-claude'), { sessionId: 'app-claude', isStarred: true });
    assert.equal(sessionsDb.getSessionById('app-claude')?.isStarred, 1);
    assert.equal(await readFile(pinsPath, 'utf8'), nativePinsBeforeOtherProviderWrites);

    await writeFile(pinsPath, '[]');
    assert.deepEqual((await getStars(baseUrl)).map((row) => row.sessionId), ['app-claude']);
  });
});

test('star listing keeps older paginated pins, archived metadata and excludes one-shot runs', async () => {
  await withStarServer(async ({ baseUrl, directory, pinsPath }) => {
    const workspace = path.join(directory, 'workspace');
    const archivedWorkspace = path.join(directory, 'archived-workspace');
    for (let index = 0; index < 51; index += 1) {
      sessionsDb.createSession(`newer-${index}`, 'omp', workspace, 'Recent unpinned session',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    }
    sessionsDb.createSession('old-pin', 'omp', workspace, 'Old pinned title',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    sessionsDb.createSession('archived-pin', 'omp', archivedWorkspace, 'Archived pinned title',
      '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    sessionsDb.updateSessionIsArchived('archived-pin', true);
    sessionsDb.createSession('one-shot-pin', 'omp', workspace, 'Hidden pin',
      undefined, undefined, undefined, { isOneShot: true });
    projectsDb.updateCustomProjectName(workspace, 'Current workspace');
    projectsDb.updateCustomProjectName(archivedWorkspace, 'Retired workspace');
    projectsDb.updateProjectIsArchived(archivedWorkspace, true);
    await writeFile(pinsPath, JSON.stringify(['old-pin', 'archived-pin', 'one-shot-pin']));

    const firstPage = sessionsDb.getRecentSessionsPage(50, 0);
    assert.equal(firstPage.sessions.some((session) => session.session_id === 'old-pin'), false);
    const stars = await getStars(baseUrl);
    assert.deepEqual(stars.map((session) => ({
      id: session.sessionId,
      title: session.sessionTitle,
      project: session.projectDisplayName,
      archived: session.isArchived,
      projectArchived: session.isProjectArchived,
      oneShot: session.isOneShot,
    })), [
      { id: 'archived-pin', title: 'Archived pinned title', project: 'Retired workspace', archived: true, projectArchived: true, oneShot: false },
      { id: 'old-pin', title: 'Old pinned title', project: 'Current workspace', archived: false, projectArchived: false, oneShot: false },
    ]);
    assert.equal(stars[1]?.lastActivity, '2026-01-01T00:00:00.000Z');
  });
});

test('bounded title and transcript searches select native pins before limiting or scanning', async () => {
  await withStarServer(async ({ baseUrl, directory, pinsPath }) => {
    const { searchConversations } = await import('@/modules/providers/services/session-conversations-search.service.js');
    const workspace = path.join(directory, 'workspace');
    const archivedWorkspace = path.join(directory, 'archived-workspace');
    const fixtures = [
      { id: 'older-pin', timestamp: '2026-01-01T00:00:00.000Z', workspace, oneShot: false },
      { id: 'newer-stale-star', timestamp: '2026-05-01T00:00:00.000Z', workspace, oneShot: false },
      { id: 'archived-pin', timestamp: '2026-04-01T00:00:00.000Z', workspace, oneShot: false },
      { id: 'archived-project-pin', timestamp: '2026-03-01T00:00:00.000Z', workspace: archivedWorkspace, oneShot: false },
      { id: 'one-shot-pin', timestamp: '2026-02-01T00:00:00.000Z', workspace, oneShot: true },
    ];
    for (const fixture of fixtures) {
      const transcriptPath = path.join(directory, `${fixture.id}.jsonl`);
      await writeFile(transcriptPath, [
        { type: 'session', version: 3, id: fixture.id, timestamp: fixture.timestamp, cwd: fixture.workspace },
        { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'Needle transcript match' }] } },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      sessionsDb.createSession(fixture.id, 'omp', fixture.workspace, 'Needle title',
        fixture.timestamp, fixture.timestamp, transcriptPath, { isOneShot: fixture.oneShot });
    }
    sessionsDb.updateSessionIsStarred('newer-stale-star', true);
    sessionsDb.updateSessionIsArchived('archived-pin', true);
    projectsDb.updateProjectIsArchived(archivedWorkspace, true);
    await writeFile(pinsPath, JSON.stringify(['older-pin', 'archived-pin', 'archived-project-pin', 'one-shot-pin']));

    const unfiltered = await searchConversations('needle', 1);
    assert.deepEqual(unfiltered.titleResults.map((session) => session.sessionId), ['newer-stale-star']);
    const starred = await searchConversations('needle', 1, null, null, null, true);
    assert.deepEqual(starred.titleResults.map((session) => session.sessionId), ['older-pin']);
    assert.equal(starred.totalMatches, 1);
    assert.deepEqual(starred.results.flatMap((project) => project.sessions.map((session) => session.sessionId)), ['older-pin']);

    await writeStar(baseUrl, 'older-pin', false);
    const unpinned = await searchConversations('needle', 1, null, null, null, true);
    assert.deepEqual(unpinned.titleResults, []);
    assert.deepEqual(unpinned.results, []);
    assert.equal(unpinned.totalMatches, 0);
  });
});
