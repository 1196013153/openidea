//! Live connections (one small pool per data source) and statement execution.
//!
//! Statements run through `raw_sql` (PostgreSQL's simple query protocol,
//! MySQL's text protocol), so every value arrives as text and is shown as is,
//! whatever its type.

use crate::source::{DataSource, DbDriver, DbSslMode};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::{
    Column, ColumnIndex, Connection, Decode, Executor, MySql, Postgres, Row, SqlSafeStr, Sqlite, TypeInfo, ValueRef,
    mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode},
    pool::PoolConnection,
    postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode},
    sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions},
};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbResultColumn")]
pub struct ResultColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbQueryResult")]
pub struct QueryResult {
    pub statement: String,
    pub columns: Vec<ResultColumn>,
    /// Cell text; `None` is SQL NULL. Binary values are `0x…` hex.
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows changed by a DML statement (`None` for queries).
    pub affected: Option<f64>,
    /// More rows exist beyond the limit.
    pub has_more: bool,
    pub elapsed_ms: f64,
}

pub enum Pool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    Mysql(MySqlPool),
}

/// Runs `$body` with `$p` bound to the concrete pool of each driver.
macro_rules! with_pool {
    ($pool:expr, $p:ident => $body:expr) => {
        match $pool {
            Pool::Sqlite($p) => $body,
            Pool::Postgres($p) => $body,
            Pool::Mysql($p) => $body,
        }
    };
}

pub(crate) fn db_err(e: sqlx::Error) -> IdeError {
    match &e {
        sqlx::Error::Database(d) => {
            let code = d.code().map(|c| c.into_owned());
            // Wrong password: PostgreSQL 28P01, MySQL 1045 (SQLSTATE 28000).
            let auth = matches!(code.as_deref(), Some("28P01" | "28000" | "1045"));
            let msg = match code {
                Some(c) => format!("[{c}] {}", d.message()),
                None => d.message().to_owned(),
            };
            IdeError::new(if auth { ErrorKind::PermissionDenied } else { ErrorKind::InvalidInput }, msg)
        }
        sqlx::Error::PoolTimedOut => IdeError::new(ErrorKind::Io, "timed out connecting to the database"),
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) => IdeError::new(ErrorKind::Io, e.to_string()),
        _ => IdeError::new(ErrorKind::Protocol, e.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// The text of column `i` of `row`.
fn cell<R: Row>(row: &R, i: usize) -> Option<String>
where
    usize: ColumnIndex<R>,
    for<'r> String: Decode<'r, R::Database>,
    for<'r> Vec<u8>: Decode<'r, R::Database>,
{
    let raw = row.try_get_raw(i).ok()?;
    if raw.is_null() {
        return None;
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    if ty.contains("BLOB") || ty.contains("BINARY") {
        let raw = row.try_get_raw(i).ok()?;
        return <Vec<u8> as Decode<R::Database>>::decode(raw).ok().map(|b| hex(&b));
    }
    match <String as Decode<R::Database>>::decode(raw) {
        Ok(s) => Some(s),
        Err(_) => {
            let raw = row.try_get_raw(i).ok()?;
            <Vec<u8> as Decode<R::Database>>::decode(raw)
                .ok()
                .map(|b| String::from_utf8(b).unwrap_or_else(|e| hex(e.as_bytes())))
        }
    }
}

fn result_columns<R: Row>(row: &R) -> Vec<ResultColumn> {
    row.columns()
        .iter()
        .map(|c| ResultColumn { name: c.name().to_owned(), type_name: c.type_info().name().to_owned() })
        .collect()
}

/// Streams the results of `$sql` on executor `$exec`, keeping at most `$max` rows.
macro_rules! fetch {
    ($exec:expr, $sql:expr, $max:expr) => {{
        use futures::StreamExt;
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe($sql.to_owned())).fetch_many($exec);
        let mut columns: Vec<ResultColumn> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut affected: Option<u64> = None;
        let mut has_more = false;
        let mut failure = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(sqlx::Either::Left(done)) => affected = Some(affected.unwrap_or(0) + done.rows_affected()),
                Ok(sqlx::Either::Right(row)) => {
                    if columns.is_empty() {
                        columns = result_columns(&row);
                    }
                    if rows.len() >= $max {
                        has_more = true;
                        break;
                    }
                    rows.push((0..row.len()).map(|i| cell(&row, i)).collect());
                }
                Err(e) => {
                    failure = Some(db_err(e));
                    break;
                }
            }
        }
        drop(stream);
        match failure {
            Some(e) => Err(e),
            None => Ok((columns, rows, affected, has_more)),
        }
    }};
}

type Fetched = (Vec<ResultColumn>, Vec<Vec<Option<String>>>, Option<u64>, bool);

/// The server-side id of a connection (to cancel its statement from another one).
macro_rules! backend_id {
    ($conn:expr, $sql:expr) => {{
        let fetched: IdeResult<Fetched> = fetch!($conn, $sql, 1);
        fetched
            .ok()
            .and_then(|f| f.1.into_iter().next())
            .and_then(|r| r.into_iter().next().flatten())
            .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
    }};
}

fn looks_like_query(sql: &str) -> bool {
    let first = sql
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("--"))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC"
    )
}

impl Pool {
    pub fn driver(&self) -> DbDriver {
        match self {
            Pool::Sqlite(_) => DbDriver::Sqlite,
            Pool::Postgres(_) => DbDriver::Postgres,
            Pool::Mysql(_) => DbDriver::Mysql,
        }
    }

    /// Opens a pool and one connection (so bad settings fail here).
    pub async fn connect(source: &DataSource, password: Option<&str>, root: Option<&Path>) -> IdeResult<Self> {
        const MAX: u32 = 4;
        let timeout = Duration::from_secs(30);
        match source.driver {
            DbDriver::Sqlite => {
                let file = source.file.as_deref().ok_or_else(|| IdeError::invalid("no database file"))?;
                let file = match root {
                    Some(r) if file.is_relative() => r.join(file),
                    _ => file.to_path_buf(),
                };
                let opts =
                    SqliteConnectOptions::new().filename(&file).create_if_missing(false).read_only(source.read_only);
                let pool = SqlitePoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .connect_with(opts)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Sqlite(pool))
            }
            DbDriver::Postgres => {
                let mut opts = PgConnectOptions::new()
                    .host(&source.host)
                    .port(source.port.unwrap_or(5432))
                    .username(&source.user)
                    .application_name("OpenIDEA")
                    .ssl_mode(match source.ssl {
                        DbSslMode::Disable => PgSslMode::Disable,
                        DbSslMode::Prefer => PgSslMode::Prefer,
                        DbSslMode::Require => PgSslMode::Require,
                    });
                if !source.database.is_empty() {
                    opts = opts.database(&source.database);
                }
                if let Some(p) = password {
                    opts = opts.password(p);
                }
                if source.read_only {
                    opts = opts.options([("default_transaction_read_only", "on")]);
                }
                let pool = PgPoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .connect_with(opts)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Postgres(pool))
            }
            DbDriver::Mysql => {
                let mut opts = MySqlConnectOptions::new()
                    .host(&source.host)
                    .port(source.port.unwrap_or(3306))
                    .username(&source.user)
                    .ssl_mode(match source.ssl {
                        DbSslMode::Disable => MySqlSslMode::Disabled,
                        DbSslMode::Prefer => MySqlSslMode::Preferred,
                        DbSslMode::Require => MySqlSslMode::Required,
                    });
                if !source.database.is_empty() {
                    opts = opts.database(&source.database);
                }
                if let Some(p) = password {
                    opts = opts.password(p);
                }
                let read_only = source.read_only;
                let pool = MySqlPoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .after_connect(move |conn, _| {
                        Box::pin(async move {
                            if read_only {
                                conn.execute("SET SESSION TRANSACTION READ ONLY").await?;
                            }
                            Ok(())
                        })
                    })
                    .connect_with(opts)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Mysql(pool))
            }
        }
    }

    pub async fn close(&self) {
        with_pool!(self, p => p.close().await)
    }

    /// Runs `sql` (no row limit beyond `max`), for introspection.
    pub async fn rows(&self, sql: &str, max: usize) -> IdeResult<Vec<Vec<Option<String>>>> {
        let fetched: IdeResult<Fetched> = with_pool!(self, p => fetch!(p, sql, max));
        Ok(fetched?.1)
    }

    /// Runs one statement and keeps at most `max_rows` rows. Cancelling stops
    /// the statement on the server (PostgreSQL, MySQL) and drops the connection.
    pub async fn execute(&self, sql: &str, max_rows: usize, cancel: &CancellationToken) -> IdeResult<QueryResult> {
        let mut conn = Held::acquire(self).await?;
        let r = conn.execute(self, sql, max_rows, cancel).await;
        if cancel.is_cancelled() {
            conn.discard().await;
            return Err(IdeError::cancelled());
        }
        r
    }

    /// Runs `statements` in one transaction; each must change `expect_one`
    /// row when flagged (table editor submits).
    pub async fn transaction(&self, statements: &[(String, bool)]) -> IdeResult<u64> {
        with_pool!(self, p => {
            let mut tx = p.begin().await.map_err(db_err)?;
            let mut total = 0;
            for (sql, expect_one) in statements {
                let done = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone())).execute(&mut *tx).await.map_err(db_err)?;
                let n = done.rows_affected();
                // MySQL reports 0 for an UPDATE that leaves the row unchanged.
                if *expect_one && (n > 1 || (n == 0 && !matches!(self, Pool::Mysql(_)))) {
                    return Err(IdeError::invalid(format!("{sql}: expected to change 1 row, changed {n}; nothing was saved")));
                }
                total += n;
            }
            tx.commit().await.map_err(db_err)?;
            Ok(total)
        })
    }
}

/// A connection taken out of a pool: for one statement, or held by a
/// manual-commit console across statements with its transaction open.
pub enum Held {
    Sqlite(PoolConnection<Sqlite>),
    Postgres(PoolConnection<Postgres>),
    Mysql(PoolConnection<MySql>),
}

impl Held {
    pub async fn acquire(pool: &Pool) -> IdeResult<Self> {
        Ok(match pool {
            Pool::Sqlite(p) => Held::Sqlite(p.acquire().await.map_err(db_err)?),
            Pool::Postgres(p) => Held::Postgres(p.acquire().await.map_err(db_err)?),
            Pool::Mysql(p) => Held::Mysql(p.acquire().await.map_err(db_err)?),
        })
    }

    /// Runs a statement without results (`BEGIN`, `COMMIT`, `ROLLBACK`).
    pub async fn command(&mut self, sql: &str) -> IdeResult<()> {
        let sql = sqlx::AssertSqlSafe(sql.to_owned());
        match self {
            Held::Sqlite(c) => sqlx::raw_sql(sql).execute(&mut **c).await.map(drop),
            Held::Postgres(c) => sqlx::raw_sql(sql).execute(&mut **c).await.map(drop),
            Held::Mysql(c) => sqlx::raw_sql(sql).execute(&mut **c).await.map(drop),
        }
        .map_err(db_err)
    }

    /// Closes the connection instead of returning it to the pool (its statement was
    /// interrupted; an open transaction is rolled back by the server).
    pub async fn discard(self) {
        match self {
            Held::Sqlite(c) => drop(c.detach()),
            Held::Postgres(c) => {
                let _ = c.detach().close().await;
            }
            Held::Mysql(c) => {
                let _ = c.detach().close().await;
            }
        }
    }

    /// Runs one statement on this connection (see [`Pool::execute`]); after a
    /// cancellation the caller must [`discard`](Self::discard) it.
    pub async fn execute(
        &mut self,
        pool: &Pool,
        sql: &str,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let started = Instant::now();
        // `$id`: the query naming the server process, `$kill`: how another connection stops it.
        macro_rules! run {
            ($conn:expr, $id:expr, $kill:expr) => {{
                let backend = match $id {
                    Some(q) => backend_id!(&mut **$conn, q),
                    None => None,
                };
                let r = tokio::select! {
                    r = async { fetch!(&mut **$conn, sql, max_rows) } => r,
                    () = cancel.cancelled() => Err(IdeError::cancelled()),
                };
                if cancel.is_cancelled() {
                    if let Some(b) = backend {
                        let _ = pool.rows(&$kill(b), 1).await;
                    }
                    return Err(IdeError::cancelled());
                }
                let mut r = r?;
                if r.0.is_empty() && looks_like_query(sql) {
                    r.0 = (&mut **$conn)
                        .prepare(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str())
                        .await
                        .map(|s| statement_columns(&s))
                        .unwrap_or_default();
                }
                r
            }};
        }
        let fetched: Fetched = match self {
            Held::Sqlite(c) => run!(c, None::<&str>, |_: String| String::new()),
            Held::Postgres(c) => {
                run!(c, Some("SELECT pg_backend_pid()"), |b: String| format!("SELECT pg_cancel_backend({b})"))
            }
            Held::Mysql(c) => run!(c, Some("SELECT CONNECTION_ID()"), |b: String| format!("KILL QUERY {b}")),
        };
        let (columns, rows, affected, has_more) = fetched;
        Ok(QueryResult {
            statement: sql.to_owned(),
            affected: if columns.is_empty() { Some(affected.unwrap_or(0) as f64) } else { None },
            columns,
            rows,
            has_more,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

/// The statement opening a transaction.
pub fn begin_statement(driver: DbDriver) -> &'static str {
    match driver {
        DbDriver::Mysql => "START TRANSACTION",
        DbDriver::Sqlite | DbDriver::Postgres => "BEGIN",
    }
}

fn statement_columns<S: sqlx::Statement>(s: &S) -> Vec<ResultColumn> {
    s.columns()
        .iter()
        .map(|c| ResultColumn { name: c.name().to_owned(), type_name: c.type_info().name().to_owned() })
        .collect()
}
