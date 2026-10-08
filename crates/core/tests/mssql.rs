//! The runner against a real SQL Server:
//!   docker run -d --name liftoff-mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Liftoff!2026" -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
//!   LIFTOFF_TEST_MSSQL="sqlserver://localhost:51433;encrypt=true;trustServerCertificate=true;user=sa;password=Liftoff!2026" \
//!     cargo test -p liftoff-core --test mssql -- --include-ignored
//! It drops and recreates the databases shop_test and shop_dev on that server.

use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::db::Conn;
use liftoff_core::runner::{self, Level, MigrateOptions, State};
use liftoff_core::{diff, Error};

fn quiet(_: Level, _: &str) {}

fn env(base: &str, db: &str, role: Role, allow_clean: bool) -> Environment {
    Environment { url: format!("{base};databaseName={db}"), user: None, password: None, role, allow_clean, placeholders: Default::default() }
}

#[tokio::test]
#[ignore = "needs SQL Server: set LIFTOFF_TEST_MSSQL"]
async fn runner_on_sql_server() {
    let base = std::env::var("LIFTOFF_TEST_MSSQL").expect("set LIFTOFF_TEST_MSSQL");
    let master = Conn::open("master", &env(&base, "master", Role::Prod, false)).await.unwrap();
    for db in ["shop_test", "shop_dev"] {
        master
            .batch(&format!(
                "IF DB_ID('{db}') IS NOT NULL BEGIN ALTER DATABASE [{db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{db}]; END; CREATE DATABASE [{db}];"
            ))
            .await
            .unwrap();
    }
    let dir = std::env::temp_dir().join(format!("liftoff-mssql-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    config::init(&dir, "shop", "sqlserver").unwrap();
    config::save_environment(&dir, "test", &env(&base, "shop_test", Role::Test, false), true).unwrap();
    config::save_environment(&dir, "dev", &env(&base, "shop_dev", Role::Dev, true), true).unwrap();
    let mut cfg = Config::load(&dir).unwrap();
    assert_eq!((cfg.project.engine.as_str(), cfg.project.schemas.clone()), ("sqlserver", vec!["dbo".to_string()]));
    cfg.project.placeholders.insert("app_role".into(), "shop_app".into());
    config::save_project(&dir, &cfg.project).unwrap();
    let cfg = Config::load(&dir).unwrap();
    let write = |n: &str, sql: &str| std::fs::write(dir.join("migrations").join(n), sql).unwrap();
    let test = || async { Conn::open("test", cfg.env("test").unwrap()).await.unwrap() };
    let exists = |c: Conn, name: &'static str| async move {
        c.batch(&format!("IF OBJECT_ID(N'{name}') IS NULL THROW 50000, 'absent', 1;")).await.is_ok()
    };

    // 1. GO batches, a procedure, a repeated batch, a placeholder, a repeatable; a second run is a no-op.
    write(
        "V1__orders.sql",
        "CREATE ROLE ${app_role};\nGO\nCREATE TABLE dbo.orders (id int IDENTITY PRIMARY KEY, note nvarchar(100) NOT NULL);\nGO\n\
         CREATE PROCEDURE dbo.add_order @note nvarchar(100) AS\nBEGIN\n  INSERT INTO dbo.orders (note) VALUES (@note);\nEND\nGO\n\
         EXEC dbo.add_order N'GO on its own line inside a string\nGO\nstill one string';\nGO 2\n",
    );
    write("R__order_view.sql", "CREATE OR ALTER VIEW dbo.order_notes AS SELECT id, note FROM dbo.orders;\n");
    let (a, b, c) = tokio::join!(
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
    );
    let applied = a.unwrap().applied.len() + b.unwrap().applied.len() + c.unwrap().applied.len();
    assert_eq!(applied, 2, "the application lock let each script run once");
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty());
    let infos = runner::info(&cfg, Some("test")).await.unwrap();
    assert!(infos.iter().all(|i| i.state == State::Applied), "{infos:#?}");
    let t = test().await;
    t.batch("IF (SELECT COUNT(*) FROM dbo.orders) <> 2 THROW 50000, 'GO 2 should insert twice', 1;").await.unwrap();
    t.batch("IF DATABASE_PRINCIPAL_ID('shop_app') IS NULL THROW 50000, 'placeholder not replaced', 1;").await.unwrap();

    // 2. A failing script rolls back completely (XACT_ABORT) and leaves no history row.
    write("V2__broken.sql", "CREATE TABLE dbo.half_done (id int);\nGO\nINSERT INTO dbo.no_such_table VALUES (1);\n");
    let err = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_err();
    assert!(matches!(&err, Error::Migration { msg, .. } if msg.contains("no_such_table") && msg.contains("error 208")), "{err}");
    assert!(!exists(test().await, "dbo.half_done").await, "rolled back");
    assert_eq!(runner::info(&cfg, Some("test")).await.unwrap().iter().find(|i| i.script == "V2__broken.sql").unwrap().state, State::Pending);

    // 3. Fixed, plus a script that cannot run in a transaction.
    write("V2__broken.sql", "CREATE TABLE dbo.half_done (id int);\n");
    write("V3__recovery.sql", "ALTER DATABASE CURRENT SET RECOVERY SIMPLE;\n");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.iter().map(|a| (a.script.as_str(), a.transactional)).collect::<Vec<_>>(), [("V2__broken.sql", true), ("V3__recovery.sql", false)]);

    // 4. An edited script is caught; repair realigns it. Undo runs the U script.
    write("V2__broken.sql", "CREATE TABLE dbo.half_done (id int, x int);\n");
    let err = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_err();
    assert!(err.to_string().contains("V2__broken.sql changed after it was applied"), "{err}");
    let rep = runner::repair(&cfg, Some("test"), &quiet).await.unwrap();
    assert_eq!(rep.realigned, ["V2__broken.sql"]);
    runner::validate_env(&cfg, Some("test")).await.unwrap();
    write("V4__total.sql", "ALTER TABLE dbo.orders ADD total decimal(10, 2) NULL;\n");
    write("U4__total.sql", "ALTER TABLE dbo.orders DROP COLUMN total;\n");
    runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    let u = runner::undo(&cfg, Some("test"), &quiet).await.unwrap();
    assert_eq!(u.script, "U4__total.sql");
    test().await.batch("IF COL_LENGTH('dbo.orders', 'total') IS NOT NULL THROW 50000, 'undo did not run', 1;").await.unwrap();
    assert_eq!(runner::info(&cfg, Some("test")).await.unwrap().iter().find(|i| i.script == "V4__total.sql").unwrap().state, State::Pending);

    // 5. Dry run speaks T-SQL.
    let dry = runner::migrate(&cfg, Some("test"), MigrateOptions { dry_run: true, ..Default::default() }, &quiet).await.unwrap().dry_run_sql.unwrap();
    assert!(dry.contains("BEGIN TRANSACTION;") && dry.contains("SUSER_SNAME()") && dry.contains("[dbo].[liftoff_schema_history]"), "{dry}");

    // 6. A database with tables and no history asks for a baseline; then only later scripts run.
    let dev = Conn::open("dev", cfg.env("dev").unwrap()).await.unwrap();
    dev.batch("CREATE TABLE dbo.legacy (id int PRIMARY KEY); CREATE TABLE dbo.orders (id int IDENTITY PRIMARY KEY, note nvarchar(100) NOT NULL);").await.unwrap();
    let err = runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap_err();
    assert!(matches!(err, Error::NotBaselined(_)), "{err}");
    runner::baseline(&cfg, Some("dev"), "3", "existing", &quiet).await.unwrap();
    let r = runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.iter().map(|a| a.script.as_str()).collect::<Vec<_>>(), ["V4__total.sql", "R__order_view.sql"]);

    // 7. Clean removes everything, whatever depends on what; the schema stays.
    dev.batch(
        "CREATE TABLE dbo.customers (id int PRIMARY KEY);
         ALTER TABLE dbo.legacy ADD customer_id int REFERENCES dbo.customers (id);
         CREATE TYPE dbo.money_amount FROM decimal(12, 2);
         CREATE SEQUENCE dbo.invoice_no START WITH 1;",
    )
    .await
    .unwrap();
    dev.batch("CREATE VIEW dbo.legacy_ids WITH SCHEMABINDING AS SELECT id FROM dbo.legacy;").await.unwrap();
    dev.batch("CREATE FUNCTION dbo.legacy_count() RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM dbo.legacy_ids) END;").await.unwrap();
    assert!(runner::clean(&cfg, Some("test"), &quiet).await.is_err(), "clean is off for test");
    runner::clean(&cfg, Some("dev"), &quiet).await.unwrap();
    dev.batch(
        "IF EXISTS (SELECT 1 FROM sys.objects WHERE schema_id = SCHEMA_ID('dbo') AND is_ms_shipped = 0 AND parent_object_id = 0)
            OR EXISTS (SELECT 1 FROM sys.types WHERE is_user_defined = 1 AND schema_id = SCHEMA_ID('dbo'))
         THROW 50000, 'clean left objects behind', 1;",
    )
    .await
    .unwrap();
    let r = runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.len(), 5, "a cleaned database takes every script again: {:?}", r.applied);

    // 8. Capture works; what is not built for SQL Server yet says so.
    let cap = diff::capture(&cfg, Some("dev"), "existing schema", false).await.unwrap();
    assert!(cap.sql.contains("CREATE TABLE [dbo].[orders]"), "{}", cap.sql);
    let err = liftoff_core::flyway::import_history(&cfg, Some("dev"), "flyway_schema_history", false, &quiet).await.unwrap_err().to_string();
    assert!(err.contains("PostgreSQL only"), "{err}");

    std::fs::remove_dir_all(&dir).unwrap();
}
