//! Postgres connections, the run lock and the history table.

use crate::config::Environment;
use crate::error::{Error, Result};
use serde::Serialize;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use tokio_postgres::Client;
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

pub async fn connect(env_name: &str, env: &Environment) -> Result<Client> {
    let fail = |msg: String| Error::Connect { env: env_name.to_string(), msg };
    for v in [Some(&env.url), env.user.as_ref(), env.password.as_ref()].into_iter().flatten() {
        if let Some(i) = v.find("${env.") {
            let var = v[i + 6..].split('}').next().unwrap_or("");
            return Err(fail(format!("environment variable {var} is not set")));
        }
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
    // Timestamps in the history table are written in UTC.
    client.batch_execute("SET TIME ZONE 'UTC'").await?;
    Ok(client)
}

/// The same connection URL, pointing at another database on the same server.
pub fn with_database(url: &str, db: &str) -> String {
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

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub version: String,
    pub user: String,
    pub database: String,
}

pub async fn server_info(c: &Client) -> Result<ServerInfo> {
    let r = c.query_one("select current_setting('server_version'), current_user::text, current_database()::text", &[]).await?;
    Ok(ServerInfo { version: r.get(0), user: r.get(1), database: r.get(2) })
}

/// Session-level advisory lock keyed on the history table, so concurrent runs queue up.
/// Polls with pg_try_advisory_lock instead of blocking: a run blocked inside pg_advisory_lock
/// holds an open transaction, and CREATE INDEX CONCURRENTLY in the lock holder waits for every
/// open transaction, which deadlocks. Released by `unlock` or when the connection closes.
pub async fn lock(c: &Client, schema: &str, table: &str, on_wait: impl Fn()) -> Result<()> {
    let key = format!("{schema}.{table}");
    let mut waited = false;
    loop {
        let got: bool = c.query_one("select pg_try_advisory_lock(hashtext($1))", &[&key]).await?.get(0);
        if got {
            return Ok(());
        }
        if !waited {
            on_wait();
            waited = true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub async fn unlock(c: &Client, schema: &str, table: &str) -> Result<()> {
    c.execute("select pg_advisory_unlock(hashtext($1))", &[&format!("{schema}.{table}")]).await?;
    Ok(())
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
    let r = c.query_one("select to_regclass($1) is not null", &[&format!("{}.{}", quote_ident(schema), quote_ident(table))]).await?;
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
    Ok(c.query(&sql, &[]).await?.iter().map(|r| HistoryRow {
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
        "insert into {}.{} (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
         select coalesce(max(installed_rank), 0) + 1, $1, $2, $3, $4, $5, current_user, $6, $7 from {0}.{1}",
        quote_ident(schema),
        quote_ident(table)
    );
    c.execute(&sql, &[&row.version, &row.description, &row.kind, &row.script, &row.checksum, &row.execution_time, &row.success]).await?;
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
