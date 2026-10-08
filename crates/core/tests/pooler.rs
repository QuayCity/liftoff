//! Everything through PgBouncer in transaction-pooling mode, with prepared statements switched off
//! (max_prepared_statements = 0): the setup Flyway users report hangs and lock failures on.
//!   docker run -d --name liftoff-bouncer --link liftoff-pg:pg -p 56432:5432 -e DB_HOST=pg -e DB_USER=postgres \
//!     -e DB_PASSWORD=liftoff -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e MAX_PREPARED_STATEMENTS=0 \
//!     -e DEFAULT_POOL_SIZE=5 edoburu/pgbouncer
//!   LIFTOFF_TEST_PGBOUNCER=postgres://postgres:liftoff@localhost:56432 cargo test -p liftoff-core --test pooler -- --include-ignored

use liftoff_core::config::{self, Config, Environment, LockMode, Role};
use liftoff_core::runner::{self, Level, MigrateOptions, State};
use liftoff_core::{db, diff};

fn quiet(_: Level, _: &str) {}

#[tokio::test]
#[ignore = "needs PgBouncer: set LIFTOFF_TEST_PGBOUNCER"]
async fn through_pgbouncer_transaction_pooling() {
    let base = std::env::var("LIFTOFF_TEST_PGBOUNCER").expect("set LIFTOFF_TEST_PGBOUNCER");
    let dir = std::env::temp_dir().join(format!("liftoff-pooler-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    config::init(&dir, "pooled", "postgresql").unwrap();
    for (name, dbname, role) in [("dev", "shop_dev", Role::Dev), ("scratch", "shop_scratch", Role::Scratch), ("test", "shop_test", Role::Test)] {
        let env = Environment { url: format!("{base}/{dbname}"), user: None, password: None, role, allow_clean: false, placeholders: Default::default() };
        config::save_environment(&dir, name, &env, true).unwrap();
    }
    let mut cfg = Config::load(&dir).unwrap();
    cfg.project.lock = LockMode::Table;
    config::save_project(&dir, &cfg.project).unwrap();
    let cfg = Config::load(&dir).unwrap();
    assert_eq!(cfg.project.lock, LockMode::Table, "saved to liftoff.toml");

    for name in ["dev", "scratch", "test"] {
        let c = db::connect(name, cfg.env(name).unwrap()).await.unwrap();
        c.batch_execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;").await.unwrap();
    }
    let write = |n: &str, sql: &str| std::fs::write(dir.join("migrations").join(n), sql).unwrap();
    write("V1__orders.sql", "create table orders (id bigint primary key, note text);\n");
    write("V2__note_index.sql", "create index concurrently orders_note_idx on orders (note);\n");
    write("R__order_ids.sql", "create or replace view order_ids as select id from orders;\n");

    // Three runs at once: the lease lock lets exactly one apply each script.
    let (a, b, c) = tokio::join!(
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
        runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet),
    );
    let applied = a.unwrap().applied.len() + b.unwrap().applied.len() + c.unwrap().applied.len();
    assert_eq!(applied, 3, "each script ran exactly once");
    let infos = runner::info(&cfg, Some("test")).await.unwrap();
    assert!(infos.iter().all(|i| i.state == State::Applied), "{infos:#?}");
    runner::validate_env(&cfg, Some("test")).await.unwrap();

    let t = db::connect("test", cfg.env("test").unwrap()).await.unwrap();
    let held: i64 = db::row(&t, "select count(*) from liftoff_schema_history_lock", &[]).await.unwrap().get(0);
    assert_eq!(held, 0, "the lease is released after each run");

    // A lease left by a crashed run expires; a live one is waited for.
    t.batch_execute("insert into liftoff_schema_history_lock values (1, 'crashed run', now() - interval '1 minute')").await.unwrap();
    write("V3__more.sql", "alter table orders add column total numeric;\n");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.len(), 1, "a stale lease does not block");
    t.batch_execute("insert into liftoff_schema_history_lock values (1, 'someone else', now() + interval '1 minute')").await.unwrap();
    write("V4__more.sql", "alter table orders add column paid boolean;\n");
    let started = std::time::Instant::now();
    let release = async {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        t.batch_execute("delete from liftoff_schema_history_lock").await.unwrap();
    };
    let (r, ()) = tokio::join!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet), release);
    assert_eq!(r.unwrap().applied.len(), 1);
    assert!(started.elapsed() >= std::time::Duration::from_secs(2), "it waited for the live lease");

    // The whole diff loop through the pooler.
    runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap();
    let d = db::connect("dev", cfg.env("dev").unwrap()).await.unwrap();
    d.batch_execute("create table customers (id bigint generated always as identity primary key, email text not null);").await.unwrap();
    let cmp = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    assert_eq!(cmp.changes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["table:public.customers"]);
    let g = diff::generate(&cfg, &cmp.changes, "customers", false).unwrap();
    diff::save(&cfg, &g.file_name, &g.sql).unwrap();
    runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    runner::mark_applied(&cfg, Some("dev"), &g.file_name, &quiet).await.unwrap();
    assert!(diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap().changes.is_empty());

    // Introspection's SET LOCAL must not leak to whoever gets the pooled connection next.
    for _ in 0..10 {
        let any = db::connect("test", cfg.env("test").unwrap()).await.unwrap();
        let sp: String = db::row(&any, "select current_setting('search_path')", &[]).await.unwrap().get(0);
        assert!(!sp.contains("pg_catalog"), "search_path leaked: {sp}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
