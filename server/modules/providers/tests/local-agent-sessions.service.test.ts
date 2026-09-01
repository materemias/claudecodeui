import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  detectLocalAgentSessions,
  localAgentSessionsService,
} from '@/modules/providers/services/local-agent-sessions.service.js';

type ProcessFixtureOptions = {
  cmdline?: string;
  procStart?: string;
  writeStat?: boolean;
};

async function createProcessFixture(
  procRoot: string,
  pid: string,
  provider: string,
  options: ProcessFixtureOptions = {},
): Promise<string> {
  const processDirectory = path.join(procRoot, pid);
  const procStart = options.procStart ?? '39811279';
  await mkdir(path.join(processDirectory, 'fd'), { recursive: true });
  await writeFile(path.join(processDirectory, 'comm'), `${provider}\n`);
  await writeFile(path.join(processDirectory, 'cmdline'), options.cmdline ?? `${provider}\0`);
  if (options.writeStat !== false) {
    const statFields = ['S', ...Array.from({ length: 18 }, () => '0'), procStart];
    await writeFile(path.join(processDirectory, 'stat'), `${pid} (${provider}) ${statFields.join(' ')}\n`);
  }
  await symlink('/dev/pts/7', path.join(processDirectory, 'fd', '0'));
  return processDirectory;
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'local-agent-db-'));

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

test('detects a Claude session attached to a terminal', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const homeDirectory = path.join(fixtureRoot, 'home');
  const procRoot = path.join(fixtureRoot, 'proc');
  const procStart = '39811279';

  try {
    await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
    await createProcessFixture(procRoot, '1234', 'claude', { procStart });
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', '1234.json'),
      JSON.stringify({ sessionId: 'claude-native-session', procStart }),
    );

    assert.deepEqual(
      detectLocalAgentSessions({ procRoot, homeDirectory, platform: 'linux' }),
      [{ provider: 'claude', providerSessionId: 'claude-native-session' }],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('prefers an omp main transcript over a newer advisor sidecar', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const procRoot = path.join(fixtureRoot, 'proc');
  const sessionId = '019ff4ae-4802-7000-82da-a2fb031932c2';
  const sessionFile = path.join(
    fixtureRoot,
    'home',
    '.omp',
    'agent',
    'sessions',
    `2026-08-12T06-34-50-242Z_${sessionId}.jsonl`,
  );
  const sidecarFile = path.join(
    fixtureRoot,
    'home',
    '.omp',
    'agent',
    'sessions',
    `2026-08-12T06-34-50-242Z_${sessionId}`,
    '__advisor.default.jsonl',
  );

  try {
    await mkdir(path.dirname(sidecarFile), { recursive: true });
    const processDirectory = await createProcessFixture(procRoot, '2345', 'omp');
    await writeFile(sessionFile, '{}\n');
    await writeFile(sidecarFile, '{}\n');
    await utimes(sessionFile, new Date(1_000), new Date(1_000));
    await utimes(sidecarFile, new Date(2_000), new Date(2_000));
    await symlink(sidecarFile, path.join(processDirectory, 'fd', '3'));
    await symlink(sessionFile, path.join(processDirectory, 'fd', '4'));

    assert.deepEqual(
      detectLocalAgentSessions({
        procRoot,
        homeDirectory: path.join(fixtureRoot, 'home'),
        platform: 'linux',
      }),
      [{ provider: 'omp', providerSessionId: sessionId }],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('uses an omp resume id only before a main transcript is open', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const procRoot = path.join(fixtureRoot, 'proc');
  const resumedSessionId = '019ff2df-3a66-7000-8ccb-097e3550ce6f';
  const currentSessionId = '019ff4ae-4802-7000-82da-a2fb031932c2';
  const sessionFile = path.join(
    fixtureRoot,
    'home',
    '.omp',
    'agent',
    'sessions',
    `2026-08-12T06-34-50-242Z_${currentSessionId}.jsonl`,
  );

  try {
    const processDirectory = await createProcessFixture(procRoot, '2345', 'omp', {
      cmdline: `omp\0--resume\0${resumedSessionId}\0`,
    });

    assert.deepEqual(
      detectLocalAgentSessions({ procRoot, homeDirectory: path.join(fixtureRoot, 'home'), platform: 'linux' }),
      [{ provider: 'omp', providerSessionId: resumedSessionId }],
    );

    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, '{}\n');
    await symlink(sessionFile, path.join(processDirectory, 'fd', '3'));

    assert.deepEqual(
      detectLocalAgentSessions({ procRoot, homeDirectory: path.join(fixtureRoot, 'home'), platform: 'linux' }),
      [{ provider: 'omp', providerSessionId: currentSessionId }],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('detects the newest open Codex rollout', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const procRoot = path.join(fixtureRoot, 'proc');
  const sessionsDirectory = path.join(fixtureRoot, 'home', '.codex', 'sessions', '2026', '08', '12');
  const oldSessionId = '019ff114-44c9-7000-a111-111111111111';
  const newSessionId = '019ff111-8390-7000-a222-222222222222';

  try {
    await mkdir(sessionsDirectory, { recursive: true });
    const processDirectory = await createProcessFixture(procRoot, '3456', 'codex');
    const oldRollout = path.join(sessionsDirectory, `rollout-old-${oldSessionId}.jsonl`);
    const newRollout = path.join(sessionsDirectory, `rollout-new-${newSessionId}.jsonl`);
    await writeFile(oldRollout, '{}\n');
    await writeFile(newRollout, '{}\n');
    await utimes(oldRollout, new Date(1_000), new Date(1_000));
    await utimes(newRollout, new Date(2_000), new Date(2_000));
    await symlink(oldRollout, path.join(processDirectory, 'fd', '3'));
    await symlink(newRollout, path.join(processDirectory, 'fd', '4'));

    assert.deepEqual(
      detectLocalAgentSessions({
        procRoot,
        homeDirectory: path.join(fixtureRoot, 'home'),
        platform: 'linux',
      }),
      [{ provider: 'codex', providerSessionId: newSessionId }],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects stale or malformed process identity', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const homeDirectory = path.join(fixtureRoot, 'home');
  const procRoot = path.join(fixtureRoot, 'proc');

  try {
    await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
    await createProcessFixture(procRoot, '1234', 'claude', { procStart: '39811280' });
    await createProcessFixture(procRoot, '2345', 'codex', { writeStat: false });
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', '1234.json'),
      JSON.stringify({ sessionId: 'stale-session', procStart: '39811279' }),
    );

    assert.deepEqual(detectLocalAgentSessions({ procRoot, homeDirectory, platform: 'linux' }), []);

    await writeFile(path.join(homeDirectory, '.claude', 'sessions', '1234.json'), '{malformed');
    assert.deepEqual(detectLocalAgentSessions({ procRoot, homeDirectory, platform: 'linux' }), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('does not treat a single prompt word as a helper command', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const homeDirectory = path.join(fixtureRoot, 'home');
  const procRoot = path.join(fixtureRoot, 'proc');
  const procStart = '39811279';

  try {
    await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
    await createProcessFixture(procRoot, '1234', 'claude', {
      cmdline: 'claude\0doctor\0',
      procStart,
    });
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', '1234.json'),
      JSON.stringify({ sessionId: 'prompt-session', procStart }),
    );

    assert.deepEqual(
      detectLocalAgentSessions({ procRoot, homeDirectory, platform: 'linux' }),
      [{ provider: 'claude', providerSessionId: 'prompt-session' }],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('ignores print, worker and non-terminal provider processes', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const homeDirectory = path.join(fixtureRoot, 'home');
  const procRoot = path.join(fixtureRoot, 'proc');
  const procStart = '39811279';
  const ompSessionId = '019ff4ae-4802-7000-82da-a2fb031932c2';
  const ompSessionFile = path.join(
    homeDirectory,
    '.omp',
    'agent',
    'sessions',
    `2026-08-12T06-34-50-242Z_${ompSessionId}.jsonl`,
  );

  try {
    await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
    await mkdir(path.dirname(ompSessionFile), { recursive: true });
    await createProcessFixture(procRoot, '1234', 'claude', {
      cmdline: 'claude\0-p\0question\0',
      procStart,
    });
    const ompProcess = await createProcessFixture(procRoot, '2345', 'omp', {
      cmdline: 'omp\0__omp_worker_mnemopi_embed\0',
    });
    const codexProcess = await createProcessFixture(procRoot, '3456', 'codex');
    await rm(path.join(codexProcess, 'fd', '0'));
    await symlink('/dev/null', path.join(codexProcess, 'fd', '0'));
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', '1234.json'),
      JSON.stringify({ sessionId: 'print-session', procStart }),
    );
    await writeFile(ompSessionFile, '{}\n');
    await symlink(ompSessionFile, path.join(ompProcess, 'fd', '3'));

    assert.deepEqual(detectLocalAgentSessions({ procRoot, homeDirectory, platform: 'linux' }), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('fails closed off Linux and removes sessions whose process disappears', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const procRoot = path.join(fixtureRoot, 'proc');
  const sessionId = '019ff4ae-4802-7000-82da-a2fb031932c2';
  const sessionFile = path.join(fixtureRoot, 'home', '.omp', 'agent', 'sessions', `${sessionId}.jsonl`);

  try {
    const processDirectory = await createProcessFixture(procRoot, '2345', 'omp');
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, '{}\n');
    await symlink(sessionFile, path.join(processDirectory, 'fd', '3'));

    assert.deepEqual(detectLocalAgentSessions({ procRoot, platform: 'darwin' }), []);
    assert.equal(detectLocalAgentSessions({ procRoot, platform: 'linux' }).length, 1);

    await rm(processDirectory, { recursive: true, force: true });
    assert.deepEqual(detectLocalAgentSessions({ procRoot, platform: 'linux' }), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('maps native ids to canonical app sessions and excludes archived projects', { concurrency: false }, async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'local-agent-detector-'));
  const homeDirectory = path.join(fixtureRoot, 'home');
  const procRoot = path.join(fixtureRoot, 'proc');
  const nativeSessionId = '019ff4ae-4802-7000-82da-a2fb031932c2';
  const projectPath = path.join(fixtureRoot, 'project');
  const sessionFile = path.join(
    homeDirectory,
    '.omp',
    'agent',
    'sessions',
    `2026-08-12T06-34-50-242Z_${nativeSessionId}.jsonl`,
  );

  try {
    await mkdir(path.dirname(sessionFile), { recursive: true });
    const processDirectory = await createProcessFixture(procRoot, '2345', 'omp');
    await writeFile(sessionFile, '{}\n');
    await symlink(sessionFile, path.join(processDirectory, 'fd', '3'));

    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session', 'omp', projectPath);
      sessionsDb.assignProviderSessionId('app-session', nativeSessionId);

      assert.deepEqual(
        localAgentSessionsService.listRunningSessions({ procRoot, homeDirectory, platform: 'linux' }),
        [{ sessionId: 'app-session', provider: 'omp', source: 'terminal', lastSeq: 0 }],
      );

      const project = projectsDb.getProjectPath(projectPath);
      assert.ok(project);
      projectsDb.updateProjectIsArchivedById(project.project_id, true);
      assert.deepEqual(
        localAgentSessionsService.listRunningSessions({ procRoot, homeDirectory, platform: 'linux' }),
        [],
      );
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
