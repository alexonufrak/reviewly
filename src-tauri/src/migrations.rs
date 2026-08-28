use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "kv + review_drafts",
            sql: r#"
            CREATE TABLE IF NOT EXISTS kv (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );
            CREATE TABLE IF NOT EXISTS review_drafts (
                pr_key      TEXT PRIMARY KEY,
                body        TEXT NOT NULL DEFAULT '',
                comments    TEXT NOT NULL DEFAULT '[]',
                updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "pr_cache (local PR mirror)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS pr_cache (
                scope       TEXT NOT NULL,
                pr_id       INTEGER NOT NULL,
                updated_at  TEXT NOT NULL DEFAULT '',
                state       TEXT NOT NULL DEFAULT '',
                data        TEXT NOT NULL,
                synced_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                PRIMARY KEY (scope, pr_id)
            );
            CREATE INDEX IF NOT EXISTS pr_cache_scope_updated
                ON pr_cache (scope, updated_at DESC);
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "pull_requests (accumulating per-id base for lists + analytics)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS pull_requests (
                id           INTEGER PRIMARY KEY,
                repo         TEXT NOT NULL DEFAULT '',
                author       TEXT NOT NULL DEFAULT '',
                state        TEXT NOT NULL DEFAULT '',
                created_at   TEXT,
                merged_at    TEXT,
                closed_at    TEXT,
                last_seen    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );
            CREATE INDEX IF NOT EXISTS pull_requests_created ON pull_requests (created_at);
            CREATE INDEX IF NOT EXISTS pull_requests_merged  ON pull_requests (merged_at);
            CREATE INDEX IF NOT EXISTS pull_requests_closed  ON pull_requests (closed_at);
            CREATE INDEX IF NOT EXISTS pull_requests_repo    ON pull_requests (repo);
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "pull_requests.is_draft (drafts trend series)",
            sql: "ALTER TABLE pull_requests ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "prs (local-first list source) + repo_sync (per-repo watermark)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS prs (
                id             INTEGER PRIMARY KEY,
                repo           TEXT NOT NULL,
                number         INTEGER NOT NULL,
                title          TEXT NOT NULL DEFAULT '',
                state          TEXT NOT NULL DEFAULT 'open',
                draft          INTEGER NOT NULL DEFAULT 0,
                merged_at      TEXT,
                author_login   TEXT NOT NULL DEFAULT '',
                author_avatar  TEXT NOT NULL DEFAULT '',
                author_url     TEXT NOT NULL DEFAULT '',
                author_id      INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL DEFAULT '',
                updated_at     TEXT NOT NULL DEFAULT '',
                html_url       TEXT NOT NULL DEFAULT '',
                repository_url TEXT,
                body           TEXT,
                labels         TEXT NOT NULL DEFAULT '[]',
                head_ref       TEXT,
                base_ref       TEXT,
                synced_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );
            CREATE INDEX IF NOT EXISTS prs_repo_state   ON prs (repo, state);
            CREATE INDEX IF NOT EXISTS prs_repo_updated ON prs (repo, updated_at DESC);
            CREATE INDEX IF NOT EXISTS prs_merged       ON prs (merged_at);

            CREATE TABLE IF NOT EXISTS repo_sync (
                repo           TEXT PRIMARY KEY,
                open_synced_at INTEGER,
                updated_high   TEXT,
                all_backfilled INTEGER NOT NULL DEFAULT 0,
                last_error     TEXT
            );
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "consolidate: drop pull_requests + pr_cache (prs is the single source)",
            sql: r#"
            DROP TABLE IF EXISTS pull_requests;
            DROP TABLE IF EXISTS pr_cache;
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "automated review queue, findings, and tone profile",
            sql: r#"
            CREATE TABLE IF NOT EXISTS auto_review_repo_settings (
                repo               TEXT PRIMARY KEY,
                enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
                model_override     TEXT,
                reasoning_override TEXT,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auto_review_runs (
                id                       TEXT PRIMARY KEY,
                repo                     TEXT NOT NULL,
                pr_id                    INTEGER NOT NULL,
                pr_number                INTEGER NOT NULL,
                pr_title                 TEXT NOT NULL,
                pr_url                   TEXT NOT NULL,
                author_login             TEXT NOT NULL,
                base_sha                 TEXT NOT NULL,
                head_sha                 TEXT NOT NULL,
                status                   TEXT NOT NULL CHECK (
                    status IN ('queued', 'running', 'completed', 'failed', 'superseded')
                ),
                trigger                  TEXT NOT NULL CHECK (
                    trigger IN ('launch', 'assignment', 'head_changed', 'reconnect', 'retry')
                ),
                context_mode             TEXT CHECK (context_mode IN ('worktree', 'diff_only')),
                provider                 TEXT NOT NULL DEFAULT 'codex' CHECK (provider = 'codex'),
                model                    TEXT,
                reasoning                TEXT,
                conclusion               TEXT CHECK (conclusion IN ('findings', 'no_concerns')),
                overall_comment          TEXT,
                tone_sample_hash         TEXT,
                queued_at                INTEGER NOT NULL,
                started_at               INTEGER,
                completed_at             INTEGER,
                error_code               TEXT,
                error_message            TEXT,
                repair_count             INTEGER NOT NULL DEFAULT 0,
                recovery_count           INTEGER NOT NULL DEFAULT 0,
                superseded_by_head_sha   TEXT,
                json_artifact_path       TEXT,
                markdown_artifact_path   TEXT,
                export_error             TEXT,
                notification_kind        TEXT,
                notification_due_at      INTEGER,
                notified_at              INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS auto_review_runs_repo_pr_head
                ON auto_review_runs (repo, pr_number, head_sha);
            CREATE INDEX IF NOT EXISTS auto_review_runs_status_queued
                ON auto_review_runs (status, queued_at);
            CREATE INDEX IF NOT EXISTS auto_review_runs_pr_completed
                ON auto_review_runs (repo, pr_number, completed_at DESC);

            CREATE TABLE IF NOT EXISTS auto_review_findings (
                id          TEXT PRIMARY KEY,
                run_id      TEXT NOT NULL REFERENCES auto_review_runs(id) ON DELETE CASCADE,
                ordinal     INTEGER NOT NULL,
                category    TEXT NOT NULL CHECK (
                    category IN ('correctness', 'security', 'data', 'concurrency', 'performance',
                                 'maintainability', 'test_coverage', 'question')
                ),
                confidence  TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
                path        TEXT NOT NULL,
                line        INTEGER NOT NULL CHECK (line > 0),
                end_line    INTEGER NOT NULL CHECK (end_line >= line),
                side        TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
                comment     TEXT NOT NULL,
                evidence    TEXT,
                github_url  TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS auto_review_findings_run_ordinal
                ON auto_review_findings (run_id, ordinal);

            CREATE TABLE IF NOT EXISTS review_tone_samples (
                source_id     TEXT PRIMARY KEY,
                source_kind   TEXT NOT NULL CHECK (source_kind IN ('review', 'comment')),
                repo          TEXT NOT NULL,
                pr_number     INTEGER NOT NULL,
                body          TEXT NOT NULL,
                submitted_at  TEXT NOT NULL,
                fetched_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS review_tone_samples_submitted
                ON review_tone_samples (submitted_at DESC);

            CREATE TABLE IF NOT EXISTS review_style_profile (
                id                 INTEGER PRIMARY KEY CHECK (id = 1),
                sample_hash        TEXT,
                generated_profile  TEXT NOT NULL DEFAULT '',
                user_override      TEXT NOT NULL DEFAULT '',
                generated_at       INTEGER,
                refreshed_at       INTEGER,
                last_error         TEXT
            );
            INSERT OR IGNORE INTO review_style_profile (id) VALUES (1);
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "track viewed automated review results",
            sql: "ALTER TABLE auto_review_runs ADD COLUMN viewed_at INTEGER;",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::migrations;
    use sqlx::{Connection, Row, SqliteConnection};

    async fn apply(connection: &mut SqliteConnection, sql: &str) {
        sqlx::raw_sql(sql).execute(connection).await.unwrap();
    }

    #[test]
    fn migration_versions_include_automated_review_schema() {
        let versions: Vec<i64> = migrations()
            .into_iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[tokio::test]
    async fn automated_review_migration_applies_after_current_schema() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        apply(&mut connection, "PRAGMA foreign_keys = ON;").await;
        for migration in migrations() {
            apply(&mut connection, migration.sql).await;
        }

        let tables: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'auto_review_%' OR name LIKE 'review_%') ORDER BY name",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get("name"))
        .collect();
        assert_eq!(
            tables,
            vec![
                "auto_review_findings",
                "auto_review_repo_settings",
                "auto_review_runs",
                "review_drafts",
                "review_style_profile",
                "review_tone_samples",
            ]
        );

        let indexes: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'auto_review_%' ORDER BY name",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get("name"))
        .collect();
        assert!(indexes.contains(&"auto_review_runs_repo_pr_head".to_string()));
        assert!(indexes.contains(&"auto_review_findings_run_ordinal".to_string()));

        let columns: Vec<String> = sqlx::query("PRAGMA table_info(auto_review_runs)")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get("name"))
            .collect();
        assert!(columns.contains(&"viewed_at".to_string()));

        let foreign_keys = sqlx::query("PRAGMA foreign_key_list(auto_review_findings)")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(foreign_keys.len(), 1);
        assert_eq!(foreign_keys[0].get::<String, _>("on_delete"), "CASCADE");
    }
}
