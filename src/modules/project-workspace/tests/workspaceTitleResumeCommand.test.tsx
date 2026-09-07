import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

const sessionResumeCommand = vi.hoisted(() => vi.fn());
const clipboardWriteText = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api', () => ({
  api: {
    sessionResumeCommand,
  },
  readApiJson: async (response: Response) => {
    const payload = await response.json() as { data?: unknown };
    return payload;
  },
}));

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
}));

vi.mock('@/shared/ui', () => ({
  LLMProviderLogo: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const selectedProject: Project = {
  projectId: 'project-1',
  displayName: 'Project',
  fullPath: '/workspace/project',
};

const selectedSession: ProjectSession = {
  id: 'app-session',
  title: 'Session',
  __provider: 'claude',
};

beforeEach(() => {
  sessionResumeCommand.mockReset();
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
});

test('copy resume button fetches the server command and reports success', async () => {
  const command = "cd -- '/workspace/project' && omp -r \"native-session\"";
  sessionResumeCommand.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { command } }),
  });

  const { getByRole } = render(
    React.createElement(WorkspaceTitle, {
      activeTab: 'chat',
      selectedProject,
      selectedSession,
      shouldShowTasksTab: false,
    }),
  );
  const button = getByRole('button');

  fireEvent.click(button);

  await waitFor(() => {
    assert.equal(sessionResumeCommand.mock.calls.length, 1);
    assert.equal(sessionResumeCommand.mock.calls[0][0], 'app-session');
    assert.deepEqual(clipboardWriteText.mock.calls[0], [command]);
    assert.equal(button.getAttribute('aria-label'), 'Resume command copied');
  });
});

test('does not copy a previous session command after the selected session changes', async () => {
  type MockResponse = {
    ok: boolean;
    json: () => Promise<{ data: { command: string } }>;
  };

  let finishRequest: ((response: MockResponse) => void) | undefined;
  sessionResumeCommand.mockImplementation(
    () =>
      new Promise<MockResponse>((resolve) => {
        finishRequest = resolve;
      }),
  );
  const view = render(
    React.createElement(WorkspaceTitle, {
      activeTab: 'chat',
      selectedProject,
      selectedSession,
      shouldShowTasksTab: false,
    }),
  );
  fireEvent.click(view.getByRole('button'));
  await waitFor(() => assert.equal(sessionResumeCommand.mock.calls.length, 1));

  const nextSession: ProjectSession = {
    ...selectedSession,
    id: 'next-session',
  };
  view.rerender(
    React.createElement(WorkspaceTitle, {
      activeTab: 'chat',
      selectedProject,
      selectedSession: nextSession,
      shouldShowTasksTab: false,
    }),
  );

  if (!finishRequest) {
    throw new Error('The mocked resume request did not start.');
  }
  finishRequest({
    ok: true,
    json: async () => ({ data: { command: 'old-session-command' } }),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(clipboardWriteText.mock.calls.length, 0);
});
