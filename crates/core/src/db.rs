//! Connections, the run lock and the history table. `Conn` is what the runner uses, for either
//! engine; the rest of this file is PostgreSQL, which comparisons and checks use directly.

use crate::config::Environment;
use crate::error::{Error, Result};
use serde::Serialize;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, Row};

/// A typed parameter. Queries go out as one unnamed statement (no named prepared statements, no
/// session state), so they also work through connection poolers in transaction mode.
pub type P<'a> = (&'a (dyn ToSql + Sync), Type);

pub async fn rows(c: &Client, sql: &str, params: &[P<'_>]) -> Result<Vec<Row>> {
    Ok(c.query_typed(sql, params).await?)
}

pub async fn row(c: &Client, sql: &str, params: &[P<'_>]) -> Result<Row> {
    rows(c, sql, params).await?.into_iter().next().ok_or_else(|| Error::Config(format!("no row returned by: {sql}")))
}

pub async fn exec(c: &Client, sql: &str, params: &[P<'_>]) -> Result<u64> {
    Ok(c.execute_typed(sql, params).await?)
}
use tokio_postgres_rustls::MakeRustlsConnect;

/// TLS via rustls, trusting the operating system's certificate store. `sslmode` in the URL decides:
/// `disable` never, `prefer` (default) when the server offers it, `require` always.
/// Certificates are always verified when TLS is used; there is no "trust anything" mode.
fn tls() -> MakeRustlsConnect {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(config)
    });
    MakeRustlsConnect::new((**config).clone())
}

fn check_vars(env_name: &str, env: &Environment) -> Result<()> {
    for v in [Some(&env.url), env.user.as_ref(), env.password.as_ref()].into_iter().flatten() {
        if let Some(i) = v.find("${env.") {
            let var = v[i + 6..].split('}').next().unwrap_or("");
            return Err(Error::Connect { env: env_name.to_string(), msg: format!("environment variable {var} is not set") });
        }
    }
    Ok(())
}

/// A PostgreSQL connection, for comparisons, checks and the schema model.
pub async fn connect(env_name: &str, env: &Environment) -> Result<Client> {
    let fail = |msg: String| Error::Connect { env: env_name.to_string(), msg };
    check_vars(env_name, env)?;
    if crate::mssql::is_url(&env.url) {
        return Err(Error::Config(format!(
            "'{env_name}' is SQL Server; this needs PostgreSQL"
        )));
    }
    let mut cfg = tokio_postgres::Config::from_str(&env.url).map_err(|e| fail(format!("bad url: {e}")))?;
    if let Some(u) = &env.user { cfg.user(u); }
    if let Some(p) = &env.password { cfg.password(p); }
    cfg.application_name("liftoff");
    cfg.connect_timeout(std::time::Duration::from_secs(10));
    let (client, conn) = cfg.connect(tls()).await.map_err(|e| fail(e.to_string()))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    // No session settings here: behind a transaction pooler they would leak to other clients.
    // History timestamps are written in UTC explicitly instead (insert_history).
    Ok(client)
}

/// The same connection URL, pointing at another database on the same server.
pub fn with_database(url: &str, db: &str) -> String {
    if crate::mssql::is_url(url) {
        let mut parts: Vec<&str> = url.split(';').filter(|p| !p.split('=').next().is_some_and(|k| k.trim().eq_ignore_ascii_case("databaseName") || k.trim().eq_ignore_ascii_case("database"))).collect();
        let db = format!("databaseName={db}");
        parts.push(&db);
        return parts.join(";");
    }
    if let Some(i) = url.find("://") {
        let (scheme, rest) = url.split_at(i + 3);
        let (main, query) = rest.split_once('?').map(|(m, q)| (m, format!("?{q}"))).unwrap_or((rest, String::new()));
        let host = main.split('/').next().unwrap_or(main);
        return format!("{scheme}{host}/{db}{query}");
    }
    // key=value form
    let mut parts: Vec<String> = url.split_whitespace().filter(|p| !p.starts_with("dbname=")).map(String::from).collect();
    parts.push(format!("dbname={db}"));
    parts.join(" ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Postgres,
    SqlServer,
}

impl Engine {
    pub fn of(url: &str) -> Engine {
        if crate::mssql::is_url(url) { Engine::SqlServer } else { Engine::Postgres }
    }

    pub fn name(self) -> &'static str {
        match self {
            Engine::Postgres => "PostgreSQL",
            Engine::SqlServer => "SQL Server",
        }
    }

    pub fn quote(self, s: &str) -> String {
        match self {
            Engine::Postgres => quote_ident(s),
            Engine::SqlServer => crate::mssql::quote(s),
        }
    }

    pub fn needs_no_transaction(self, sql: &str) -> bool {
        match self {
            Engine::Postgres => crate::migration::needs_no_transaction(sql),
            Engine::SqlServer => crate::migration::tsql_needs_no_transaction(sql),
        }
    }

    pub fn begin(self) -> &'static str {
        match self {
            Engine::Postgres => "BEGIN",
            Engine::SqlServer => "BEGIN TRANSACTION",
        }
    }

    /// The SQL expression for the logged-in user.
    pub fn current_user(self) -> &'static str {
        match self {
            Engine::Postgres => "current_user",
            Engine::SqlServer => "SUSER_SNAME()",
        }
    }
}

/// The runner's connection, for either engine.
pub enum Conn {
    Pg(Client),
    Ms(Box<crate::mssql::Db>),
}

/// A held run lock; give it back with `Conn::release`.
pub enum Held {
    Pg(RunLock),
    Ms(String),
}

impl Conn {
    pub async fn open(env_name: &str, env: &Environment) -> Result<Conn> {
        check_vars(env_name, env)?;
        match Engine::of(&env.url) {
            Engine::Postgres => Ok(Conn::Pg(connect(env_name, env).await?)),
            Engine::SqlServer => Ok(Conn::Ms(Box::new(crate::mssql::connect(env_name, env).await?))),
        }
    }

    pub fn engine(&self) -> Engine {
        match self {
            Conn::Pg(_) => Engine::Postgres,
            Conn::Ms(_) => Engine::SqlServer,
        }
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        match self {
            Conn::Pg(c) => server_info(c).await,
            Conn::Ms(c) => c.server_info().await,
        }
    }

    /// On SQL Server `mode` does not apply: it always takes a session application lock.
    pub async fn lock(&self, env_name: &str, env: &Environment, schema: &str, table: &str, mode: crate::config::LockMode, on_wait: impl Fn()) -> Result<Held> {
        match self {
            Conn::Pg(c) => Ok(Held::Pg(lock(c, env_name, env, schema, table, mode, on_wait).await?)),
            Conn::Ms(c) => {
                let resource = format!("liftoff:{schema}.{table}");
                c.lock(&resource, on_wait).await?;
                Ok(Held::Ms(resource))
            }
        }
    }

    pub async fn release(&self, held: Held) {
        match (self, held) {
            (Conn::Pg(c), Held::Pg(l)) => l.release(c).await,
            (Conn::Ms(c), Held::Ms(r)) => c.unlock(&r).await,
            _ => {}
        }
    }

    /// A control statement or a whole batch, as is (BEGIN, COMMIT, ROLLBACK, a script body).
    pub async fn batch(&self, sql: &str) -> Result<()> {
        match self {
            Conn::Pg(c) => Ok(c.batch_execute(sql).await?),
            Conn::Ms(c) => c.batch(sql).await,
        }
    }

    /// A migration script. Postgres: one batch, or statement by statement outside a transaction
    /// (each its own implicit transaction). SQL Server: batch by batch on GO lines.
    pub async fn script(&self, sql: &str, transactional: bool) -> Result<()> {
        match self {
            Conn::Pg(c) if transactional => Ok(c.batch_execute(sql).await?),
            Conn::Pg(c) => {
                for stmt in crate::migration::split_statements(sql) {
                    c.batch_execute(&stmt).await?;
                }
                Ok(())
            }
            Conn::Ms(c) => c.script(sql).await,
        }
    }

    pub async fn ensure_history(&self, schema: &str, table: &str) -> Result<()> {
        match self {
            Conn::Pg(c) => ensure_history(c, schema, table).await,
            Conn::Ms(c) => c.ensure_history(schema, table).await,
        }
    }

    pub async fn read_history(&self, schema: &str, table: &str) -> Result<Vec<HistoryRow>> {
        match self {
            Conn::Pg(c) => read_history(c, schema, table).await,
            Conn::Ms(c) => c.read_history(schema, table).await,
        }
    }

    pub async fn insert_history(&self, schema: &str, table: &str, row: NewRow<'_>) -> Result<()> {
        match self {
            Conn::Pg(c) => insert_history(c, schema, table, row).await,
            Conn::Ms(c) => c.insert_history(schema, table, row).await,
        }
    }

    /// Objects in the managed schemas besides LiftOff's own tables: a database with any of these
    /// and no history needs a baseline first.
    pub async fn user_objects(&self, schemas: &[String], table: &str) -> Result<i64> {
        match self {
            Conn::Pg(c) => Ok(row(
                c,
                "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relname <> $2 and c.relname <> $3
                   and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i', 'e'))",
                &[(&schemas, Type::TEXT_ARRAY), (&table, Type::TEXT), (&format!("{table}_lock"), Type::TEXT)],
            )
            .await?
            .get(0)),
            Conn::Ms(c) => c.user_objects(schemas, table).await,
        }
    }

    /// Removes failed rows; returns their scripts.
    pub async fn delete_failed(&self, schema: &str, table: &str) -> Result<Vec<String>> {
        match self {
            Conn::Pg(c) => Ok(rows(c, &format!("delete from {}.{} where not success returning script", quote_ident(schema), quote_ident(table)), &[])
                .await?
                .iter()
                .map(|r| r.get(0))
                .collect()),
            Conn::Ms(c) => c.delete_failed(schema, table).await,
        }
    }

    pub async fn realign(&self, schema: &str, table: &str, rank: i32, checksum: i32, description: &str) -> Result<()> {
        match self {
            Conn::Pg(c) => {
                exec(
                    c,
                    &format!("update {}.{} set checksum = $1, description = $2 where installed_rank = $3", quote_ident(schema), quote_ident(table)),
                    &[(&checksum, Type::INT4), (&description, Type::VARCHAR), (&rank, Type::INT4)],
                )
                .await?;
                Ok(())
            }
            Conn::Ms(c) => c.realign(schema, table, rank, checksum, description).await,
        }
    }

    pub async fn reset_schemas(&self, schemas: &[String]) -> Result<()> {
        match self {
            Conn::Pg(c) => crate::runner::reset_schemas(c, schemas).await,
            Conn::Ms(c) => c.reset_schemas(schemas).await,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub version: String,
    pub user: String,
    pub database: String,
}

pub async fn server_info(c: &Client) -> Result<ServerInfo> {
    let r = row(c, "select current_setting('server_version'), current_user::text, current_database()::text", &[]).await?;
    Ok(ServerInfo { version: r.get(0), user: r.get(1), database: r.get(2) })
}

/// Keeps concurrent runs on one database apart. Both modes poll instead of blocking: a run
/// blocked inside a lock call holds an open transaction, and CREATE INDEX CONCURRENTLY in the lock
/// holder waits for every open transaction, which deadlocks.
pub struct RunLock {
    mode: crate::config::LockMode,
    key: String,
    lock_table: String,
    holder: String,
    renew: Option<tokio::task::JoinHandle<()>>,
}

const LEASE_SECS: f64 = 120.0;

/// `advisory`: session-level pg_try_advisory_lock keyed on the history table; released by
/// `release` or when the connection closes.
/// `table`: a lease row in `<history table>_lock`, renewed every 30 s on its own connection and
/// expiring after 2 minutes, so a crashed run never blocks the next one for long.
pub async fn lock(
    c: &Client,
    env_name: &str,
    env: &Environment,
    schema: &str,
    table: &str,
    mode: crate::config::LockMode,
    on_wait: impl Fn(),
) -> Result<RunLock> {
    let key = format!("{schema}.{table}");
    let lock_table = format!("{}.{}", quote_ident(schema), quote_ident(&format!("{table}_lock")));
    let holder = format!(
        "{}@{} pid {} {}",
        std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
        std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    );
    if mode == crate::config::LockMode::Table {
        let created = c
            .batch_execute(&format!(
                "CREATE SCHEMA IF NOT EXISTS {s};
                 CREATE TABLE IF NOT EXISTS {lock_table} (id integer PRIMARY KEY CHECK (id = 1), holder text NOT NULL, expires_at timestamptz NOT NULL)",
                s = quote_ident(schema)
            ))
            .await;
        // IF NOT EXISTS is not safe against a run creating it at the same moment; theirs is as good as ours.
        if let Err(e) = created {
            use tokio_postgres::error::SqlState;
            if !matches!(e.code(), Some(c) if *c == SqlState::UNIQUE_VIOLATION || *c == SqlState::DUPLICATE_TABLE || *c == SqlState::DUPLICATE_SCHEMA) {
                return Err(e.into());
            }
        }
    }
    let mut waited = false;
    loop {
        let got = match mode {
            crate::config::LockMode::Advisory => row(c, "select pg_try_advisory_lock(hashtext($1))", &[(&key, Type::TEXT)]).await?.get::<_, bool>(0),
            crate::config::LockMode::Table => !rows(
                c,
                &format!(
                    "insert into {lock_table} (id, holder, expires_at) values (1, $1, now() + make_interval(secs => $2))
                     on conflict (id) do update set holder = excluded.holder, expires_at = excluded.expires_at
                     where {lock_table}.expires_at < now()
                     returning holder"
                ),
                &[(&holder, Type::TEXT), (&LEASE_SECS, Type::FLOAT8)],
            )
            .await?
            .is_empty(),
        };
        if got {
            break;
        }
        if !waited {
            on_wait();
            waited = true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    let renew = if mode == crate::config::LockMode::Table {
        // Long scripts keep the main connection busy; the lease is renewed on a second one.
        let (env_name, env, sql, holder) = (
            env_name.to_string(),
            env.clone(),
            format!("update {lock_table} set expires_at = now() + make_interval(secs => $2) where holder = $1"),
            holder.clone(),
        );
        Some(tokio::spawn(async move {
            let Ok(r) = connect(&env_name, &env).await else { return };
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let _ = exec(&r, &sql, &[(&holder, Type::TEXT), (&LEASE_SECS, Type::FLOAT8)]).await;
            }
        }))
    } else {
        None
    };
    Ok(RunLock { mode, key, lock_table, holder, renew })
}

impl RunLock {
    pub async fn release(self, c: &Client) {
        if let Some(h) = self.renew {
            h.abort();
        }
        let _ = match self.mode {
            crate::config::LockMode::Advisory => exec(c, "select pg_advisory_unlock(hashtext($1))", &[(&self.key, Type::TEXT)]).await,
            crate::config::LockMode::Table => exec(c, &format!("delete from {} where holder = $1", self.lock_table), &[(&self.holder, Type::TEXT)]).await,
        };
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    pub installed_rank: i32,
    pub version: Option<String>,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub script: String,
    pub checksum: Option<i32>,
    pub installed_by: String,
    pub installed_on: String,
    pub execution_time: i32,
    pub success: bool,
}

pub async fn history_exists(c: &Client, schema: &str, table: &str) -> Result<bool> {
    let name = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let r = row(c, "select to_regclass($1) is not null", &[(&name, Type::TEXT)]).await?;
    Ok(r.get(0))
}

/// The history table's columns.
pub async fn ensure_history(c: &Client, schema: &str, table: &str) -> Result<()> {
    let (s, t) = (quote_ident(schema), quote_ident(table));
    let idx = quote_ident(&format!("{table}_s_idx"));
    c.batch_execute(&format!(
        "CREATE SCHEMA IF NOT EXISTS {s};
         CREATE TABLE IF NOT EXISTS {s}.{t} (
           installed_rank integer NOT NULL PRIMARY KEY,
           version varchar(50),
           description varchar(200) NOT NULL,
           type varchar(20) NOT NULL,
           script varchar(1000) NOT NULL,
           checksum integer,
           installed_by varchar(100) NOT NULL,
           installed_on timestamp NOT NULL DEFAULT now(),
           execution_time integer NOT NULL,
           success boolean NOT NULL
         );
         CREATE INDEX IF NOT EXISTS {idx} ON {s}.{t} (success);"
    ))
    .await?;
    Ok(())
}

pub async fn read_history(c: &Client, schema: &str, table: &str) -> Result<Vec<HistoryRow>> {
    if !history_exists(c, schema, table).await? {
        return Ok(vec![]);
    }
    let sql = format!(
        "select installed_rank, version, description, type, script, checksum, installed_by,
                to_char(installed_on, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), execution_time, success
         from {}.{} order by installed_rank",
        quote_ident(schema),
        quote_ident(table)
    );
    Ok(rows(c, &sql, &[]).await?.iter().map(|r| HistoryRow {
        installed_rank: r.get(0),
        version: r.get(1),
        description: r.get(2),
        kind: r.get(3),
        script: r.get(4),
        checksum: r.get(5),
        installed_by: r.get(6),
        installed_on: r.get(7),
        execution_time: r.get(8),
        success: r.get(9),
    }).collect())
}

pub struct NewRow<'a> {
    pub version: Option<&'a str>,
    pub description: &'a str,
    pub kind: &'a str,
    pub script: &'a str,
    pub checksum: Option<i32>,
    pub execution_time: i32,
    pub success: bool,
}

/// Runs inside the caller's lock, so max()+1 cannot race.
pub async fn insert_history(c: &Client, schema: &str, table: &str, row: NewRow<'_>) -> Result<()> {
    let sql = format!(
        "insert into {}.{} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
         select coalesce(max(installed_rank), 0) + 1, $1, $2, $3, $4, $5, current_user, now() at time zone 'UTC', $6, $7 from {0}.{1}",
        quote_ident(schema),
        quote_ident(table)
    );
    exec(
        c,
        &sql,
        &[
            (&row.version, Type::VARCHAR),
            (&row.description, Type::VARCHAR),
            (&row.kind, Type::VARCHAR),
            (&row.script, Type::VARCHAR),
            (&row.checksum, Type::INT4),
            (&row.execution_time, Type::INT4),
            (&row.success, Type::BOOL),
        ],
    )
    .await?;
    Ok(())
}

const RESERVED: &[&str] = &[
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "binary", "both", "case", "cast",
    "check", "collate", "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
    "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default", "deferrable", "desc",
    "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign", "freeze", "from", "full", "grant", "group",
    "having", "ilike", "in", "initially", "inner", "intersect", "into", "is", "isnull", "join", "lateral", "leading", "left", "like",
    "limit", "localtime", "localtimestamp", "natural", "not", "notnull", "null", "offset", "on", "only", "or", "order", "outer",
    "overlaps", "placing", "primary", "references", "returning", "right", "select", "session_user", "similar", "some", "symmetric",
    "system_user", "table", "tablesample", "then", "to", "trailing", "true", "union", "unique", "user", "using", "variadic",
    "verbose", "when", "where", "window", "with",
];

/// Bare when safe (lowercase, not reserved), double-quoted otherwise.
pub fn quote_ident(s: &str) -> String {
    let plain = s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !RESERVED.contains(&s);
    if plain { s.to_string() } else { format!("\"{}\"", s.replace('"', "\"\"")) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn database_swaps() {
        use super::with_database as w;
        assert_eq!(w("postgres://me:pw@db:5432/shop?sslmode=require", "shop_scratch"), "postgres://me:pw@db:5432/shop_scratch?sslmode=require");
        assert_eq!(w("postgres://db", "x"), "postgres://db/x");
        assert_eq!(w("host=db dbname=shop user=me", "x"), "host=db user=me dbname=x");
    }

    #[test]
    fn quoting() {
        use super::quote_ident as q;
        assert_eq!(q("orders"), "orders");
        assert_eq!(q("order"), "\"order\"");
        assert_eq!(q("MixedCase"), "\"MixedCase\"");
        assert_eq!(q("a\"b"), "\"a\"\"b\"");
        assert_eq!(q("1abc"), "\"1abc\"");
    }
}
