//! Compare, generate, undo, drift checks, capture, squash and the schema model on a real SQL Server
//! (same setup as tests/mssql.rs). Drops and recreates shop_dev, shop_test and shop_dev_scratch.
//!   LIFTOFF_TEST_MSSQL="sqlserver://localhost:51433;encrypt=true;trustServerCertificate=true;user=sa;password=Liftoff!2026" \
//!     cargo test -p liftoff-core --test mssql_diff -- --include-ignored

use liftoff_core::checks::{self, CheckOptions};
use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::db::Conn;
use liftoff_core::runner::{self, Level, MigrateOptions};
use liftoff_core::{diff, model};

fn quiet(_: Level, _: &str) {}

fn env(base: &str, db: &str, role: Role) -> Environment {
    Environment { url: format!("{base};databaseName={db}"), user: None, password: None, role, allow_clean: false, placeholders: Default::default() }
}

#[tokio::test]
#[ignore = "needs SQL Server: set LIFTOFF_TEST_MSSQL"]
async fn diff_loop_on_sql_server() {
    let base = std::env::var("LIFTOFF_TEST_MSSQL").expect("set LIFTOFF_TEST_MSSQL");
    let master = Conn::open("master", &env(&base, "master", Role::Prod)).await.unwrap();
    for db in ["shop_dev", "shop_test", "shop_dev_scratch"] {
        master.batch(&format!("IF DB_ID('{db}') IS NOT NULL BEGIN ALTER DATABASE [{db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{db}]; END")).await.unwrap();
    }
    for db in ["shop_dev", "shop_test"] {
        master.batch(&format!("CREATE DATABASE [{db}]")).await.unwrap();
    }
    let dir = std::env::temp_dir().join(format!("liftoff-msdiff-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    config::init(&dir, "shop", "sqlserver").unwrap();
    config::save_environment(&dir, "dev", &env(&base, "shop_dev", Role::Dev), true).unwrap();
    config::save_environment(&dir, "test", &env(&base, "shop_test", Role::Test), true).unwrap();
    let created = diff::create_scratch(&Config::load(&dir).unwrap(), None, "scratch").await.unwrap();
    assert_eq!(created.database, "shop_dev_scratch");
    let cfg = Config::load(&dir).unwrap();
    let write = |n: &str, sql: &str| std::fs::write(dir.join("migrations").join(n), sql).unwrap();

    // 1. The same scripts on two databases compare equal, whatever names SQL Server made up.
    write(
        "V1__start.sql",
        "CREATE TABLE dbo.orders (
           id int IDENTITY(1,1) PRIMARY KEY,
           note nvarchar(100) NOT NULL DEFAULT (N''),
           total decimal(10,2) NULL CHECK (total >= 0),
           qty int NOT NULL CONSTRAINT df_orders_qty DEFAULT (1),
           line_total AS (qty * total)
         );
         GO
         CREATE INDEX ix_orders_note ON dbo.orders (note);
         GO
         CREATE VIEW dbo.order_notes AS SELECT id, note FROM dbo.orders;
         GO
         CREATE PROCEDURE dbo.add_order @note nvarchar(100) AS INSERT INTO dbo.orders (note) VALUES (@note);
         GO
         CREATE FUNCTION dbo.order_count() RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM dbo.orders) END;
         GO
",
    );
    for e in ["dev", "test"] {
        runner::migrate(&cfg, Some(e), MigrateOptions::default(), &quiet).await.unwrap();
    }
    let cmp = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    assert!(cmp.changes.is_empty(), "{:#?}", cmp.changes.iter().map(|c| (&c.id, &c.sql)).collect::<Vec<_>>());

    // 2. Change dev by hand in every way the diff knows.
    let dev = Conn::open("dev", cfg.env("dev").unwrap()).await.unwrap();
    for sql in [
        "CREATE TYPE dbo.money_amount FROM decimal(12, 2) NOT NULL",
        "CREATE SEQUENCE dbo.invoice_no AS bigint START WITH 1000 INCREMENT BY 1",
        "CREATE TABLE dbo.customers (id int NOT NULL PRIMARY KEY, email nvarchar(200) NOT NULL UNIQUE, credit dbo.money_amount)",
        "ALTER TABLE dbo.orders ADD customer_id int NULL FOREIGN KEY REFERENCES dbo.customers (id), status varchar(20) NOT NULL CONSTRAINT df_orders_status DEFAULT ('new')",
        "ALTER TABLE dbo.orders ALTER COLUMN note nvarchar(200) NOT NULL",
        "CREATE INDEX ix_orders_open ON dbo.orders (customer_id) INCLUDE (total) WHERE status = 'new'",
        "CREATE OR ALTER VIEW dbo.order_notes AS SELECT id, note, status FROM dbo.orders",
        "CREATE OR ALTER PROCEDURE dbo.add_order @note nvarchar(200) AS INSERT INTO dbo.orders (note) VALUES (@note)",
        "CREATE TRIGGER dbo.orders_touch ON dbo.orders AFTER UPDATE AS SET NOCOUNT ON",
        "DROP FUNCTION dbo.order_count",
    ] {
        dev.batch(sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let cmp = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    let mut ids: Vec<&str> = cmp.changes.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    assert_eq!(
        ids,
        ["function:dbo.order_count", "procedure:dbo.add_order", "sequence:dbo.invoice_no", "table:dbo.customers", "table:dbo.orders", "trigger:dbo.orders_touch", "type:dbo.money_amount", "view:dbo.order_notes"],
        "{:#?}",
        cmp.changes.iter().map(|c| (&c.id, &c.sql)).collect::<Vec<_>>()
    );
    let orders = cmp.changes.iter().find(|c| c.id == "table:dbo.orders").unwrap();
    assert!(orders.destructive, "a column type change may lose data");

    // 3. Generate with undo, run it on test, record it on dev: everything matches again.
    let g = diff::generate(&cfg, &cmp.changes, "customers and status", true).unwrap();
    diff::save(&cfg, &g.file_name, &g.sql).unwrap();
    let undo = g.undo.as_ref().unwrap();
    diff::save(&cfg, &undo.file_name, &undo.sql).unwrap();
    runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_or_else(|e| panic!("{e}\n{}", g.sql));
    runner::mark_applied(&cfg, Some("dev"), &g.file_name, &quiet).await.unwrap();
    let cmp = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    assert!(cmp.changes.is_empty(), "{:#?}\n{}", cmp.changes.iter().map(|c| (&c.id, &c.sql)).collect::<Vec<_>>(), g.sql);

    // 4. No drift on test; then the undo script takes test back and there is still no drift.
    let drift = checks::check(&cfg, Some("test"), None, CheckOptions { drift: true, ..Default::default() }, &quiet).await.unwrap();
    assert!(drift.drift.as_ref().unwrap().is_empty(), "{:#?}", drift.drift);
    runner::undo(&cfg, Some("test"), &quiet).await.unwrap_or_else(|e| panic!("{e}\n{}", undo.sql));
    let drift = checks::check(&cfg, Some("test"), None, CheckOptions { drift: true, ..Default::default() }, &quiet).await.unwrap();
    assert!(drift.drift.as_ref().unwrap().is_empty(), "after undo: {:#?}\n{}", drift.drift.as_ref().unwrap().iter().map(|c| (&c.id, &c.sql)).collect::<Vec<_>>(), undo.sql);

    // 5. Drift is seen: a hand-made index on test.
    let test = Conn::open("test", cfg.env("test").unwrap()).await.unwrap();
    test.batch("CREATE INDEX ix_by_hand ON dbo.orders (total)").await.unwrap();
    let drift = checks::check(&cfg, Some("test"), None, CheckOptions { drift: true, ..Default::default() }, &quiet).await.unwrap();
    assert_eq!(drift.drift.unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["table:dbo.orders"]);

    // 6. Capture and squash build the whole schema from nothing, checked by a rebuild.
    let cap = diff::capture(&cfg, Some("dev"), "existing schema", false).await.unwrap();
    assert!(cap.sql.contains("CREATE TABLE [dbo].[customers]") && cap.sql.contains("CREATE TRIGGER"), "{}", cap.sql);
    let (sq, path) = diff::squash(&cfg, None, "start", None, false, &quiet).await.unwrap_or_else(|e| panic!("{e}"));
    assert!(path.is_some() && sq.file_name.starts_with('B'), "{}", sq.file_name);

    // 7. The schema model writes one file per object.
    let files = model::status(&cfg, None).await.unwrap();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    for p in ["dbo/tables/orders.sql", "dbo/views/order_notes.sql", "dbo/procedures/add_order.sql", "dbo/triggers/orders_touch.sql", "dbo/sequences/invoice_no.sql", "dbo/types/money_amount.sql"] {
        assert!(paths.contains(&p), "{p} in {paths:?}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
