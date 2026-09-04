import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';
import type { ProviderSessionConfigReport } from '@/shared/types.js';

type SessionNameSource = 'provisional' | 'provider' | 'user';

type DiscoveredSessionOptions = {
  isOneShot?: boolean;
  /** Full rescans classify existing rows without restoring sessions the user archived. */
  preserveArchived?: boolean;
};

export type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  /** Owner of custom_name; NULL only for rows created before ownership tracking. */
  name_source: SessionNameSource | null;
  /** Last title read from provider storage. */
  provider_name: string | null;
  /** Model explicitly selected for this session; NULL until one is recorded. */
  model: string | null;
  /** Reasoning effort explicitly selected for this session. */
  effort: string | null;
  /** Latest model reported by the provider itself. */
  live_model: string | null;
  /** Latest reasoning effort reported by the provider itself. */
  live_effort: string | null;
  /** 1 while `model` is waiting for a matching provider report. */
  model_dirty: number;
  /** 1 while `effort` is waiting for a matching provider report. */
  effort_dirty: number;
  /** The app session this one was branched from; NULL unless it is a fork. */
  forked_from_session_id: string | null;
  /** One for non-interactive provider CLI sessions, zero for interactive sessions. */
  is_one_shot: number;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, name_source, provider_name, model, effort, live_model, live_effort, model_dirty, effort_dirty, forked_from_session_id, is_one_shot, isArchived, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row. This
   * upsert preserves an app-created row's title; synchronizers use the
   * ownership-aware title methods below for later provider retitles.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    options: DiscoveredSessionOptions = {},
  ): string {
    const { isOneShot = false, preserveArchived = false } = options;
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           is_one_shot = ?,
           isArchived = CASE WHEN ? THEN isArchived ELSE 0 END,
           custom_name = CASE
             WHEN session_id <> provider_session_id AND custom_name IS NOT NULL THEN custom_name
             ELSE COALESCE(?, custom_name)
           END
         WHERE session_id = ?`
      ).run(
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        isOneShot ? 1 : 0,
        preserveArchived ? 1 : 0,
        customName ?? null,
        existing.session_id
      );

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, is_one_shot, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'provider', ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         is_one_shot = excluded.is_one_shot,
         isArchived = CASE WHEN ? THEN sessions.isArchived ELSE 0 END,
         custom_name = CASE
           WHEN sessions.session_id <> sessions.provider_session_id AND sessions.custom_name IS NOT NULL
             THEN sessions.custom_name
           ELSE COALESCE(excluded.custom_name, sessions.custom_name)
         END`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      isOneShot ? 1 : 0,
      createdAtValue,
      updatedAtValue,
      preserveArchived ? 1 : 0,
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'provisional', ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, customName ?? null, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Inserts a session that already has its provider artifact on disk.
   *
   * Unlike `createAppSession` this writes `provider_session_id` and
   * `jsonl_path` immediately, because a fork's transcript file exists before
   * the row does — and the filesystem watcher would otherwise index it as an
   * unrelated session under its own id.
   */
  createForkedSession(input: {
    sessionId: string;
    provider: string;
    projectPath: string;
    customName: string | null;
    providerSessionId: string;
    jsonlPath: string;
    forkedFromSessionId: string;
    model: string | null;
    effort: string | null;
  }): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(input.provider, input.projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    // The watcher may already have created a row for the new transcript. Its
    // id is the provider-native one, which is what this row claims, so replace
    // it rather than leaving two sidebar entries for one conversation.
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, input.sessionId);
      db.prepare(
        `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, model, effort, forked_from_session_id, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(
        input.sessionId,
        input.provider,
        input.providerSessionId,
        input.customName,
        normalizedProjectPath,
        input.jsonlPath,
        input.model,
        input.effort,
        input.forkedFromSessionId,
      );
    })();

    return input.sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             name_source = CASE
               WHEN custom_name IS NULL THEN COALESCE(?, name_source)
               ELSE name_source
             END,
             custom_name = COALESCE(custom_name, ?),
             is_one_shot = 0,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(
          providerSessionId,
          duplicate.jsonl_path,
          duplicate.name_source,
          duplicate.custom_name,
          sessionId,
        );
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Moves one session onto a different provider session and replaces its
   * transcript path in the same transaction.
   *
   * `jsonlPath` may be NULL when a provider minted the new id before its first
   * transcript write. Clearing the old path is required: keeping it would make
   * history and usage read the abandoned source conversation under the new id.
   * If the watcher already indexed the replacement, its path is adopted.
   */
  repointSessionToProviderSession(
    sessionId: string,
    input: {
      providerSessionId: string;
      jsonlPath: string | null;
      resetLiveConfig?: boolean;
      rearmModel?: boolean;
      rearmEffort?: boolean;
    },
  ): void {
    const db = getConnection();

    db.transaction(() => {
      const indexedReplacement = db.prepare(
        `SELECT jsonl_path FROM sessions
         WHERE (session_id = ? OR provider_session_id = ?)
           AND session_id <> ?
         LIMIT 1`,
      ).get(
        input.providerSessionId,
        input.providerSessionId,
        sessionId,
      ) as { jsonl_path: string | null } | undefined;
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, sessionId);
      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           jsonl_path = ?,
           live_model = CASE WHEN ? THEN NULL ELSE live_model END,
           live_effort = CASE WHEN ? THEN NULL ELSE live_effort END,
           model_dirty = CASE WHEN ? THEN 1 ELSE model_dirty END,
           effort_dirty = CASE WHEN ? THEN 1 ELSE effort_dirty END,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(
        input.providerSessionId,
        input.jsonlPath ?? indexedReplacement?.jsonl_path ?? null,
        input.resetLiveConfig ? 1 : 0,
        input.resetLiveConfig ? 1 : 0,
        input.rearmModel ? 1 : 0,
        input.rearmEffort ? 1 : 0,
        sessionId,
      );
    })();
  },

  /**
   * Detaches a session from its provider session so the next run starts a new
   * one.
   *
   * Used when an edit replaces the very first prompt: there is no conversation
   * left to branch from, so the session starts over instead.
   */
  detachProviderSession(
    sessionId: string,
    rearm: { model?: boolean; effort?: boolean } = {},
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions SET
         provider_session_id = NULL,
         jsonl_path = NULL,
         live_model = NULL,
         live_effort = NULL,
         model_dirty = CASE WHEN ? THEN 1 ELSE model_dirty END,
         effort_dirty = CASE WHEN ? THEN 1 ELSE effort_dirty END,
         updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`
    ).run(rearm.model ? 1 : 0, rearm.effort ? 1 : 0, sessionId);
  },

  /**
   * Records that a session has left a provider session behind for good.
   *
   * The transcript stays on disk, which is deliberate — the abandoned attempt
   * is recoverable — but the indexer must not offer it back, and on a session
   * discovered from disk (whose app id *is* the provider id) rediscovering it
   * would repoint the row at the conversation the user edited away from.
   */
  markProviderSessionSuperseded(input: {
    providerSessionId: string;
    provider: string;
    sessionId: string;
    jsonlPath: string | null;
  }): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id, jsonl_path)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_session_id, provider) DO UPDATE SET
         session_id = excluded.session_id,
         jsonl_path = excluded.jsonl_path,
         created_at = CURRENT_TIMESTAMP`
    ).run(input.providerSessionId, input.provider, input.sessionId, input.jsonlPath);
  },

  isProviderSessionSuperseded(providerSessionId: string, provider: string): boolean {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 AS found FROM superseded_provider_sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { found: number } | undefined;

    return Boolean(row);
  },

  /**
   * Transcripts one session has left behind, for the caller that deletes a
   * conversation from disk.
   *
   * A conversation edited more than once has lived in more than one file, and
   * the session row only ever points at the newest.
   */
  getSupersededTranscriptPaths(sessionId: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT jsonl_path FROM superseded_provider_sessions
         WHERE session_id = ? AND jsonl_path IS NOT NULL`
      )
      .all(sessionId) as Array<{ jsonl_path: string }>;

    return rows.map((row) => row.jsonl_path);
  },

  /**
   * Forgets what a session left behind, once the session itself is gone.
   *
   * Without this the record outlives the row it was written for and keeps the
   * indexer refusing a transcript that no longer belongs to anything — a
   * conversation invisible to the app and impossible to delete through it.
   */
  clearSupersededProviderSessions(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM superseded_provider_sessions WHERE session_id = ?').run(sessionId);
  },

  /**
   * Records an explicit model choice and retires the preceding live report.
   *
   * `pending` is true only for a provider option that needs an acknowledgement.
   * The OMP configured-model sentinel therefore records with `pending=false`.
   */
  setSessionModel(sessionId: string, model: string, pending = true): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?, live_model = NULL, model_dirty = ?
       WHERE session_id = ?`
    ).run(model, pending ? 1 : 0, sessionId);
  },

  /** Records an explicit effort choice with the same sticky semantics as model. */
  setSessionEffort(sessionId: string, effort: string, pending = true): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?, live_effort = NULL, effort_dirty = ?
       WHERE session_id = ?`
    ).run(effort, pending ? 1 : 0, sessionId);
  },

  /**
   * Records the model echoed by `chat.send` only when it is a new choice.
   *
   * A value equal to `live_model` is the provider's own state reflected by the
   * composer, not a new pin, so it must not become dirty again.
   */
  recordSessionModelOnSend(sessionId: string, model: string, pending: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?, live_model = NULL, model_dirty = ?
       WHERE session_id = ?
         AND (model IS NULL OR model <> ?)
         AND (live_model IS NULL OR live_model <> ?)`
    ).run(model, pending ? 1 : 0, sessionId, model, model);
  },

  /** Send-path counterpart of `recordSessionModelOnSend` for reasoning effort. */
  recordSessionEffortOnSend(sessionId: string, effort: string, pending: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?, live_effort = NULL, effort_dirty = ?
       WHERE session_id = ?
         AND (effort IS NULL OR effort <> ?)
         AND (live_effort IS NULL OR live_effort <> ?)`
    ).run(effort, pending ? 1 : 0, sessionId, effort, effort);
  },

  /**
   * Applies one ordered provider config report atomically.
   *
   * A live mismatch is ignored while its option is dirty. A matching report
   * stores the provider value and clears only that option's dirty flag.
   * Snapshots acknowledge matching dirty choices but never overwrite clean
   * live state, because an OMP load snapshot can name a primary model while the
   * running session remains on a fallback.
   */
  applySessionConfigReport(sessionId: string, report: ProviderSessionConfigReport): boolean {
    const db = getConnection();
    return db.transaction(() => {
      let changed = false;
      for (const update of report.updates) {
        const isModel = update.field === 'model';
        const liveColumn = isModel ? 'live_model' : 'live_effort';
        const valueColumn = isModel ? 'model' : 'effort';
        const dirtyColumn = isModel ? 'model_dirty' : 'effort_dirty';
        const result = report.source === 'snapshot'
          ? db.prepare(
              `UPDATE sessions
               SET ${liveColumn} = ?, ${dirtyColumn} = 0
               WHERE session_id = ?
                 AND ${dirtyColumn} = 1
                 AND ${valueColumn} = ?`
            ).run(update.value, sessionId, update.value)
          : db.prepare(
              `UPDATE sessions
               SET ${liveColumn} = ?,
                   ${dirtyColumn} = CASE
                     WHEN ${dirtyColumn} = 1 AND ${valueColumn} = ? THEN 0
                     ELSE ${dirtyColumn}
                   END
               WHERE session_id = ?
                 AND (${dirtyColumn} = 0 OR ${valueColumn} = ?)
                 AND (${liveColumn} IS NULL OR ${liveColumn} <> ? OR ${dirtyColumn} = 1)`
            ).run(update.value, update.value, sessionId, update.value, update.value);
        changed ||= result.changes > 0;
      }
      return changed;
    })();
  },

  /**
   * Updates the displayed title and its owner in one write.
   */
  updateSessionCustomName(
    sessionId: string,
    customName: string,
    source: Exclude<SessionNameSource, 'provisional'>,
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?,
           name_source = ?
       WHERE session_id = ?`
    ).run(customName, source, sessionId);
  },

  /**
   * Records the latest title observed in provider storage.
   */
  updateSessionProviderName(sessionId: string, providerName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET provider_name = ?
       WHERE session_id = ?`
    ).run(providerName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(limit: number, offset: number): RecentSessionsPage {
    const db = getConnection();
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
      AND sessions.is_one_shot = 0
    `;
    const rows = db
      .prepare(
        `SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get() as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
           AND is_one_shot = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND is_one_shot = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND is_one_shot = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /**
   * Lists every indexed session that claims a transcript file on disk.
   *
   * Only rows with a `jsonl_path` are returned, which deliberately excludes
   * app-created sessions still waiting for their first provider write and
   * OpenCode rows (whose transcripts all live inside one shared sqlite file).
   * Used by the session synchronizer to find rows whose transcript has been
   * deleted underneath the index.
   */
  getSessionsWithTranscriptPath(): Array<{ session_id: string; jsonl_path: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, jsonl_path
         FROM sessions
         WHERE jsonl_path IS NOT NULL AND jsonl_path <> ''`
      )
      .all() as Array<{ session_id: string; jsonl_path: string }>;
  },
};
