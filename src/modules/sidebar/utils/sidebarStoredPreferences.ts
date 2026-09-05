import type { ProjectSortOrder } from '@/shared/types';
import { readUserPreference } from '@/shared/userSettings';

export const readProjectSortOrder = (): ProjectSortOrder => (
  readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name'
);

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const STARRED_SESSIONS_ONLY_STORAGE_KEY = 'sidebarStarredSessionsOnly';

/**
 * Reads whether the sidebar is filtered to starred sessions only.
 *
 * Kept in localStorage rather than the server-backed preferences because it is
 * a view filter of the device in front of the user, not an account setting.
 */
export const readStarredSessionsOnly = (): boolean => {
  try {
    return localStorage.getItem(STARRED_SESSIONS_ONLY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

/** Persists the starred-sessions-only filter so it survives a reload. */
export const writeStarredSessionsOnly = (value: boolean): void => {
  try {
    localStorage.setItem(STARRED_SESSIONS_ONLY_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};
