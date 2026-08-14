use crate::models::{KeepAliveHistoryEntry, KeepAliveStatus, Site, SiteInput};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

impl Db {
    pub fn open(path: &PathBuf) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL,
                endpoint_url TEXT NOT NULL,
                api_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Same schema the PHP app (controll-server-monitor) writes, so this
        // binary can open the exact same data/monitor.sqlite file and see the
        // same registered sites. Add the keep_alive_url column non-destructively
        // for installs that started life under the PHP app.
        let has_column: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('sites') WHERE name = 'keep_alive_url'")?
            .exists([])?;
        if !has_column {
            conn.execute("ALTER TABLE sites ADD COLUMN keep_alive_url TEXT", [])?;
        }

        // Every keep-alive ping, not just the latest (which KeepAliveState only
        // ever holds in memory and loses on every service restart) — so a
        // site's actual track record can be inspected, not just its most
        // recent result.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS keepalive_pings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id INTEGER NOT NULL,
                ok INTEGER NOT NULL,
                http_code INTEGER NOT NULL,
                error TEXT,
                ping_at TEXT NOT NULL,
                elapsed_ms INTEGER NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_keepalive_pings_site_time ON keepalive_pings (site_id, ping_at)",
            [],
        )?;

        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    fn row_to_site(row: &rusqlite::Row) -> rusqlite::Result<Site> {
        Ok(Site {
            id: row.get("id")?,
            label: row.get("label")?,
            endpoint_url: row.get("endpoint_url")?,
            api_key: row.get("api_key")?,
            keep_alive_url: row.get("keep_alive_url")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    pub fn list_sites(&self) -> rusqlite::Result<Vec<Site>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM sites ORDER BY label COLLATE NOCASE ASC")?;
        let rows = stmt.query_map([], Self::row_to_site)?;
        rows.collect()
    }

    pub fn get_site(&self, id: i64) -> rusqlite::Result<Option<Site>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT * FROM sites WHERE id = ?1", params![id], Self::row_to_site)
            .optional()
    }

    pub fn add_site(&self, input: &SiteInput) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO sites (label, endpoint_url, api_key, keep_alive_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![input.label, input.endpoint_url, input.api_key, input.keep_alive_url, ts],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_site(&self, id: i64, input: &SiteInput) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sites SET label = ?1, endpoint_url = ?2, api_key = ?3, keep_alive_url = ?4, updated_at = ?5 WHERE id = ?6",
            params![input.label, input.endpoint_url, input.api_key, input.keep_alive_url, now(), id],
        )?;
        Ok(())
    }

    pub fn delete_site(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sites WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn insert_keepalive_ping(&self, status: &KeepAliveStatus) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO keepalive_pings (site_id, ok, http_code, error, ping_at, elapsed_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                status.site_id,
                status.ok,
                status.http_code,
                status.error,
                status.last_ping_at,
                status.elapsed_ms as i64,
            ],
        )?;
        Ok(())
    }

    /// Most recent pings for one site, newest first.
    pub fn get_keepalive_history(&self, site_id: i64, limit: i64) -> rusqlite::Result<Vec<KeepAliveHistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ok, http_code, error, ping_at, elapsed_ms FROM keepalive_pings
             WHERE site_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![site_id, limit], |row| {
            Ok(KeepAliveHistoryEntry {
                id: row.get("id")?,
                ok: row.get::<_, i64>("ok")? != 0,
                http_code: row.get::<_, i64>("http_code")? as u16,
                error: row.get("error")?,
                ping_at: row.get("ping_at")?,
                elapsed_ms: row.get::<_, i64>("elapsed_ms")? as u64,
            })
        })?;
        rows.collect()
    }

    /// Keeps the table from growing forever on a machine that's left running
    /// for months — 30 days at a 5-minute interval is a few thousand rows per
    /// site, which is still trivial for SQLite, but no reason to keep more.
    pub fn prune_keepalive_history(&self, older_than_days: i64) -> rusqlite::Result<usize> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(older_than_days))
            .format("%Y-%m-%dT%H:%M:%S.%3fZ")
            .to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM keepalive_pings WHERE ping_at < ?1", params![cutoff])
    }
}
