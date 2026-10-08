//! End-to-end against a real Postgres. Needs three empty databases on one server:
//!   docker run -d --name liftoff-pg -e POSTGRES_PASSWORD=liftoff -p 55432:5432 postgres:16-alpine
//!   (create databases shop_dev, shop_scratch, shop_test)
//!   LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432 cargo test -p liftoff-core -- --include-ignored

use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::runner::{self, Level, MigrateOptions, State};
use liftoff_core::{db, diff, Error};
use std::path::{Path, PathBuf};

fn quiet(_: Level, _: &str) {}

fn env(base: &str, db: &str, role: Role) -> Environment {
    Environment { url: format!("{base}/{db}"), user: None, password: None, role, allow_clean: false }
}

async fn reset(cfg: &Config, name: &str) {
    let c = db::connect(name, cfg.env(name).unwrap()).await.unwrap();
    c.batch_execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;").await.unwrap();
}

fn write(dir: &Path, name: &str, sql: &str) {
    std::fs::write(dir.join("migrations").join(name), sql).unwrap();
}

#[tokio::test]
#[ignore = "needs Postgres: set LIFTOFF_TEST_PG"]
async fn full_slice() {
    let base = std::env::var("LIFTOFF_TEST_PG").expect("set LIFTOFF_TEST_PG, e.g. postgres://postgres:liftoff@localhost:55432");
    let dir: PathBuf = std::env::temp_dir().join(format!("liftoff-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    config::init(&dir, "shop", "postgresql").unwrap();
    for (name, db, role) in [("dev", "shop_dev", Role::Dev), ("scratch", "shop_scratch", Role::Scratch), ("test", "shop_test", Role::Test)] {
        config::save_environment(&dir, name, &env(&base, db, role), true).unwrap();
    }
    let cfg = Config::load(&dir).unwrap();
    for name in ["dev", "scratch", "test"] {
        reset(&cfg, name).await;
    }

    // 1. Versioned + repeatable apply in order; a second run is a no-op.
    write(&dir, "V1__orders.sql", "create table orders (id serial, note text);\n");
    write(&dir, "R__order_view.sql", "create or replace view order_ids as select id from orders;\n");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.iter().map(|a| a.script.as_str()).collect::<Vec<_>>(), ["V1__orders.sql", "R__order_view.sql"]);
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty());
    let info = runner::info(&cfg, Some("test")).await.unwrap();
    assert!(info.iter().all(|i| i.state == State::Applied), "{info:#?}");

    // 2. A failing transactional script rolls back fully and leaves no history row.
    write(&dir, "V2__broken.sql", "create table half_done (id int);\nselect * from no_such_table;\n");
    let err = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_err();
    assert!(matches!(err, Error::Migration { .. }), "{err}");
    assert!(err.to_string().contains("no_such_table"), "{err}");
    let c = db::connect("test", cfg.env("test").unwrap()).await.unwrap();
    let half: bool = c.query_one("select to_regclass('public.half_done') is not null", &[]).await.unwrap().get(0);
    assert!(!half, "rolled back");
    let state = |infos: &[runner::MigrationInfo], s: &str| infos.iter().find(|i| i.script == s).unwrap().state;
    assert_eq!(state(&runner::info(&cfg, Some("test")).await.unwrap(), "V2__broken.sql"), State::Pending);
    std::fs::remove_file(dir.join("migrations/V2__broken.sql")).unwrap();

    // 3. Non-transactional statements run statement by statement.
    write(&dir, "V2__index.sql", "create index concurrently orders_note_idx on orders (note);\n");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!((r.applied.len(), r.applied[0].transactional), (1, false));

    // 4. Editing an applied script blocks migrate.
    write(&dir, "V1__orders.sql", "create table orders (id serial, note text, extra int);\n");
    let err = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_err();
    assert!(matches!(err, Error::Validate(_)) && err.to_string().contains("checksum"), "{err}");
    write(&dir, "V1__orders.sql", "create table orders (id serial, note text);\n");

    // 5. Two concurrent runs on a fresh database: the lock makes each script run exactly once.
    reset(&cfg, "test").await;
    let (a, b) = tokio::join!(
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
    );
    assert_eq!(a.unwrap().applied.len() + b.unwrap().applied.len(), 3);
    let rows = db::read_history(&c, "public", &cfg.project.history_table).await.unwrap();
    assert_eq!(rows.len(), 3);

    // 6. Dev changes -> generated migration -> applied -> no differences left.
    runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap();
    let d = db::connect("dev", cfg.env("dev").unwrap()).await.unwrap();
    d.batch_execute(
        "alter table orders add column total numeric(10,2) not null default 0;
         alter table orders alter column note set not null;
         create table customers (id bigint generated always as identity, \"Name\" text not null, created_at timestamptz default now());",
    )
    .await
    .unwrap();
    let changes = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    let names: Vec<&str> = changes.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["public.customers", "public.orders"], "{changes:#?}");
    let g = diff::generate(&cfg, &changes, "customers and totals").unwrap();
    assert!(g.file_name.starts_with('V') && g.file_name.ends_with("__customers_and_totals.sql"), "{}", g.file_name);
    diff::save(&cfg, &g.file_name, &g.sql).unwrap();
    assert!(diff::save(&cfg, &g.file_name, &g.sql).is_err(), "never overwrites");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.len(), 1);
    let after = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    assert!(after.is_empty(), "round trip left differences: {after:#?}\n--- script ---\n{}", g.sql);

    // 7. Refuses to rebuild a non-scratch database.
    let err = diff::dev_vs_migrations(&cfg, Some("dev"), Some("test"), &quiet).await.unwrap_err();
    assert!(err.to_string().contains("refusing"), "{err}");

    std::fs::remove_dir_all(&dir).unwrap();
}
