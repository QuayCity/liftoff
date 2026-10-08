//! SQL Server for the runner: connection, run lock, history table and clean. Comparisons, drift
//! checks and the schema model are PostgreSQL only for now.

use crate::config::Environment;
use crate::db::{HistoryRow, NewRow, ServerInfo};
use crate::error::{Error, Result};
use std::time::Duration;
use tiberius::{AuthMethod, Client, Config, Row, ToSql};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// tiberius needs `&mut` for every call; the runner shares one connection by reference.
pub struct Db(Mutex<Client<Compat<TcpStream>>>);

pub fn is_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("sqlserver://") || u.starts_with("jdbc:sqlserver://")
}

/// `[name]`, with `]` doubled, as QUOTENAME does.
pub fn quote(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}

/// `N'text'`, with `'` doubled.
fn lit(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

fn prop<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split(';').skip(1).filter_map(|kv| kv.split_once('=')).find(|(k, _)| k.trim().eq_ignore_ascii_case(key)).map(|(_, v)| v.trim())
}

impl From<tiberius::error::Error> for Error {
    fn from(e: tiberius::error::Error) -> Self {
        Error::Sql(match &e {
            tiberius::error::Error::Server(t) => format!("{} (error {}, line {})", t.message(), t.code(), t.line()),
            other => other.to_string(),
        })
    }
}

/// `sqlserver://host:port;databaseName=shop;encrypt=true` (the JDBC form, with or without `jdbc:`).
pub async fn connect(env_name: &str, env: &Environment) -> Result<Db> {
    let fail = |msg: String| Error::Connect { env: env_name.to_string(), msg };
    let url = env.url.trim();
    let url = url.strip_prefix("jdbc:").unwrap_or(url);
    let mut cfg = Config::from_jdbc_string(&format!("jdbc:{url}")).map_err(|e| fail(format!("bad url: {e}")))?;
    let user = env.user.as_deref().or_else(|| prop(url, "user")).or_else(|| prop(url, "userName"));
    if let Some(u) = user {
        cfg.authentication(AuthMethod::sql_server(u, env.password.as_deref().or_else(|| prop(url, "password")).unwrap_or("")));
    }
    cfg.application_name("liftoff");
    let open = async move {
        // Azure SQL may send the client to another node once.
        for _ in 0..2 {
            let tcp = TcpStream::connect(cfg.get_addr()).await.map_err(|e| e.to_string())?;
            let _ = tcp.set_nodelay(true);
            match Client::connect(cfg.clone(), tcp.compat_write()).await {
                Ok(c) => return Ok(c),
                Err(tiberius::error::Error::Routing { host, port }) => {
                    cfg.host(host);
                    cfg.port(port);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("the server redirected the connection more than once".to_string())
    };
    let mut c = tokio::time::timeout(Duration::from_secs(10), open).await.map_err(|_| fail("timed out after 10 s".into()))?.map_err(fail)?;
    // A failing statement rolls back the whole transaction instead of only itself.
    c.simple_query("SET XACT_ABORT ON; SET NOCOUNT ON;").await?.into_results().await?;
    Ok(Db(Mutex::new(c)))
}

impl Db {
    pub async fn batch(&self, sql: &str) -> Result<()> {
        self.0.lock().await.simple_query(sql).await?.into_results().await?;
        Ok(())
    }

    async fn query(&self, sql: &str, params: &[&dyn ToSql]) -> Result<Vec<Row>> {
        let mut c = self.0.lock().await;
        Ok(c.query(sql, params).await?.into_first_result().await?)
    }

    async fn exec(&self, sql: &str, params: &[&dyn ToSql]) -> Result<()> {
        self.0.lock().await.execute(sql, params).await?;
        Ok(())
    }

    /// Runs a script's batches; `GO n` repeats one.
    pub async fn script(&self, sql: &str) -> Result<()> {
        for (batch, times) in crate::migration::split_batches(sql) {
            for _ in 0..times {
                self.batch(&batch).await?;
            }
        }
        Ok(())
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        let rows = self.query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), SUSER_SNAME(), DB_NAME()", &[]).await?;
        let r = rows.first().ok_or_else(|| Error::Sql("no server information".into()))?;
        let s = |i: usize| r.get::<&str, _>(i).unwrap_or_default().to_string();
        Ok(ServerInfo { version: s(0), user: s(1), database: s(2) })
    }

    /// Session-owned application lock: released by `unlock` or when the connection closes. Polls,
    /// like the Postgres lock, so a waiting run holds nothing open.
    pub async fn lock(&self, resource: &str, on_wait: impl Fn()) -> Result<()> {
        let mut waited = false;
        loop {
            let rows = self
                .query(
                    "DECLARE @r int; EXEC @r = sp_getapplock @Resource = @P1, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0; SELECT @r",
                    &[&resource],
                )
                .await?;
            if rows.first().and_then(|r| r.get::<i32, _>(0)).is_some_and(|r| r >= 0) {
                return Ok(());
            }
            if !waited {
                on_wait();
                waited = true;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn unlock(&self, resource: &str) {
        let _ = self.exec("EXEC sp_releaseapplock @Resource = @P1, @LockOwner = 'Session'", &[&resource]).await;
    }

    pub async fn history_exists(&self, schema: &str, table: &str) -> Result<bool> {
        let name = format!("{}.{}", quote(schema), quote(table));
        let rows = self.query("SELECT CASE WHEN OBJECT_ID(@P1, N'U') IS NULL THEN 0 ELSE 1 END", &[&name.as_str()]).await?;
        Ok(rows.first().and_then(|r| r.get::<i32, _>(0)) == Some(1))
    }

    /// Same columns as the Postgres table, in SQL Server types.
    pub async fn ensure_history(&self, schema: &str, table: &str) -> Result<()> {
        // CREATE SCHEMA must be alone in its batch, hence EXEC.
        self.exec("IF SCHEMA_ID(@P1) IS NULL BEGIN DECLARE @s nvarchar(400) = N'CREATE SCHEMA ' + QUOTENAME(@P1); EXEC (@s) END", &[&schema]).await?;
        if self.history_exists(schema, table).await? {
            return Ok(());
        }
        let (s, t) = (quote(schema), quote(table));
        self.batch(&format!(
            "CREATE TABLE {s}.{t} (
               installed_rank int NOT NULL PRIMARY KEY,
               version nvarchar(50) NULL,
               description nvarchar(200) NOT NULL,
               type nvarchar(20) NOT NULL,
               script nvarchar(1000) NOT NULL,
               checksum int NULL,
               installed_by nvarchar(100) NOT NULL,
               installed_on datetime NOT NULL DEFAULT GETUTCDATE(),
               execution_time int NOT NULL,
               success bit NOT NULL
             );
             CREATE INDEX {idx} ON {s}.{t} (success);",
            idx = quote(&format!("{table}_s_idx"))
        ))
        .await
    }

    pub async fn read_history(&self, schema: &str, table: &str) -> Result<Vec<HistoryRow>> {
        if !self.history_exists(schema, table).await? {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT installed_rank, version, description, type, script, checksum, installed_by,
                    CONVERT(varchar(19), installed_on, 126) + 'Z', execution_time, success
             FROM {}.{} ORDER BY installed_rank",
            quote(schema),
            quote(table)
        );
        let text = |r: &Row, i: usize| r.get::<&str, _>(i).map(String::from);
        Ok(self
            .query(&sql, &[])
            .await?
            .iter()
            .map(|r| HistoryRow {
                installed_rank: r.get(0).unwrap_or_default(),
                version: text(r, 1),
                description: text(r, 2).unwrap_or_default(),
                kind: text(r, 3).unwrap_or_default(),
                script: text(r, 4).unwrap_or_default(),
                checksum: r.get(5),
                installed_by: text(r, 6).unwrap_or_default(),
                installed_on: text(r, 7).unwrap_or_default(),
                execution_time: r.get(8).unwrap_or_default(),
                success: r.get(9).unwrap_or_default(),
            })
            .collect())
    }

    /// Runs inside the caller's lock, so MAX()+1 cannot race.
    pub async fn insert_history(&self, schema: &str, table: &str, row: NewRow<'_>) -> Result<()> {
        let t = format!("{}.{}", quote(schema), quote(table));
        self.exec(
            &format!(
                "INSERT INTO {t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
                 SELECT COALESCE(MAX(installed_rank), 0) + 1, @P1, @P2, @P3, @P4, @P5, SUSER_SNAME(), GETUTCDATE(), @P6, @P7 FROM {t}"
            ),
            &[&row.version, &row.description, &row.kind, &row.script, &row.checksum, &row.execution_time, &row.success],
        )
        .await
    }

    /// User tables, views, routines, sequences and synonyms in these schemas, besides the history table.
    pub async fn user_objects(&self, schemas: &[String], table: &str) -> Result<i64> {
        let rows = self
            .query(
                &format!(
                    "SELECT COUNT(*) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                     WHERE s.name IN ({}) AND o.is_ms_shipped = 0 AND o.parent_object_id = 0
                       AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO', 'SN') AND o.name <> @P1",
                    schemas.iter().map(|s| lit(s)).collect::<Vec<_>>().join(", ")
                ),
                &[&table],
            )
            .await?;
        Ok(rows.first().and_then(|r| r.get::<i32, _>(0)).unwrap_or(0).into())
    }

    pub async fn delete_failed(&self, schema: &str, table: &str) -> Result<Vec<String>> {
        let sql = format!("DELETE FROM {}.{} OUTPUT deleted.script WHERE success = 0", quote(schema), quote(table));
        Ok(self.query(&sql, &[]).await?.iter().filter_map(|r| r.get::<&str, _>(0).map(String::from)).collect())
    }

    pub async fn realign(&self, schema: &str, table: &str, rank: i32, checksum: i32, description: &str) -> Result<()> {
        let sql = format!("UPDATE {}.{} SET checksum = @P1, description = @P2 WHERE installed_rank = @P3", quote(schema), quote(table));
        self.exec(&sql, &[&checksum, &description, &rank]).await
    }

    /// Drops every user object in the schemas; the schemas themselves stay (dbo cannot be dropped).
    /// ponytail: drops are retried in passes until nothing is left, which covers dependencies
    /// between views and routines without working out their order; XML schema collections and
    /// full-text catalogs are not dropped.
    pub async fn reset_schemas(&self, schemas: &[String]) -> Result<()> {
        let names = schemas.iter().map(|s| lit(s)).collect::<Vec<_>>().join(", ");
        let rows = self
            .query(
                &format!(
                    "SELECT 0, N'ALTER TABLE ' + QUOTENAME(ps.name) + N'.' + QUOTENAME(pt.name) + N' DROP CONSTRAINT ' + QUOTENAME(f.name)
                     FROM sys.foreign_keys f
                     JOIN sys.tables pt ON pt.object_id = f.parent_object_id JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
                     JOIN sys.tables rt ON rt.object_id = f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
                     WHERE ps.name IN ({names}) OR rs.name IN ({names})
                     UNION ALL
                     SELECT 1, N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' SET (SYSTEM_VERSIONING = OFF)'
                     FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
                     WHERE s.name IN ({names}) AND t.temporal_type = 2
                     UNION ALL
                     SELECT CASE o.type WHEN 'U' THEN 3 WHEN 'SO' THEN 4 ELSE 2 END,
                            N'DROP ' + CASE o.type WHEN 'V' THEN N'VIEW' WHEN 'P' THEN N'PROCEDURE' WHEN 'SN' THEN N'SYNONYM'
                                                   WHEN 'U' THEN N'TABLE' WHEN 'SO' THEN N'SEQUENCE' ELSE N'FUNCTION' END
                            + N' ' + QUOTENAME(s.name) + N'.' + QUOTENAME(o.name)
                     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                     WHERE s.name IN ({names}) AND o.is_ms_shipped = 0 AND o.parent_object_id = 0
                       AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'SN', 'U', 'SO')
                     UNION ALL
                     SELECT 5, N'DROP TYPE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name)
                     FROM sys.types t JOIN sys.schemas s ON s.schema_id = t.schema_id
                     WHERE t.is_user_defined = 1 AND s.name IN ({names})
                     ORDER BY 1"
                ),
                &[],
            )
            .await?;
        let mut todo: Vec<String> = rows.iter().filter_map(|r| r.get::<&str, _>(1).map(String::from)).collect();
        while !todo.is_empty() {
            let mut left = Vec::new();
            let mut last = None;
            for stmt in &todo {
                if let Err(e) = self.batch(stmt).await {
                    left.push(stmt.clone());
                    last = Some(e);
                }
            }
            if left.len() == todo.len() {
                return Err(last.unwrap());
            }
            todo = left;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn urls_and_quoting() {
        assert!(super::is_url("jdbc:sqlserver://db:1433;databaseName=shop") && super::is_url("SQLServer://db"));
        assert!(!super::is_url("postgres://db/shop"));
        assert_eq!(super::quote("a]b"), "[a]]b]");
        assert_eq!(super::prop("sqlserver://db;databaseName=shop;User=sa", "user"), Some("sa"));
    }
}
