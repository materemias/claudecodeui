import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviderResumeCommand } from '@/shared/utils.js';

test('buildProviderResumeCommand maps every registered provider to its terminal resume command', () => {
  const sessionId = 'native-session-id';

  assert.deepEqual(buildProviderResumeCommand('claude', sessionId)?.resume, 'claude --resume "native-session-id"');
  assert.deepEqual(buildProviderResumeCommand('cursor', sessionId)?.resume, 'cursor-agent --resume="native-session-id"');
  assert.deepEqual(buildProviderResumeCommand('codex', sessionId)?.resume, 'codex resume "native-session-id"');
  assert.deepEqual(buildProviderResumeCommand('opencode', sessionId)?.resume, 'opencode --session "native-session-id"');
  assert.deepEqual(buildProviderResumeCommand('omp', sessionId)?.resume, 'omp -r "native-session-id"');
});

test('buildProviderResumeCommand preserves fresh-session and fallback behavior', () => {
  assert.deepEqual(buildProviderResumeCommand('claude', null), {
    resume: null,
    bare: 'claude',
    useInitialCommandWhenFresh: true,
    retriesWithoutResume: true,
  });
  assert.equal(buildProviderResumeCommand('cursor', null)?.useInitialCommandWhenFresh, false);
  assert.equal(buildProviderResumeCommand('codex', null)?.retriesWithoutResume, true);
  assert.equal(buildProviderResumeCommand('opencode', null)?.useInitialCommandWhenFresh, true);
  assert.equal(buildProviderResumeCommand('omp', null)?.retriesWithoutResume, true);
});

test('buildProviderResumeCommand applies Claude bypass mode only to Claude', () => {
  assert.equal(
    buildProviderResumeCommand('claude', 'native-session-id', { bypassPermissions: true })?.resume,
    'claude --resume "native-session-id" --dangerously-skip-permissions',
  );
  assert.equal(
    buildProviderResumeCommand('omp', 'native-session-id', { bypassPermissions: true })?.resume,
    'omp -r "native-session-id"',
  );
});

test('buildProviderResumeCommand rejects shell-unsafe native ids and plain shell', () => {
  assert.equal(buildProviderResumeCommand('claude', 'native;rm -rf /'), null);
  assert.equal(buildProviderResumeCommand('plain-shell', 'native-session-id'), null);
});
