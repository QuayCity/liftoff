//! The fixes from the fix plan against a real Postgres (same setup as tests/postgres.rs):
//! squash, per-environment placeholders, re-running repeatables.
//!   LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432 cargo test -p liftoff-core --test fixes -- --include-ignored

use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::runner::{self, Level, MigrateOptions};
use liftoff_core::{db, diff};

fn quiet(_: Level, _: &str) {}

#[tokio::test]
#[ignore = "needs Postgres: set LIFTOFF_TEST_PG"]
async fn squash_placeholders_rerun() {
    let base = std::env::var("LIFTOFF_TEST_PG").expect("set LIFTOFF_TEST_PG");
    let dir = std::env::temp_dir().join(format!("liftoff-fixes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    config::init(&dir, "shop", "postgresql").unwrap();
    for (name, dbname, role, who) in [("dev", "shop_dev", Role::Dev, "dev_app"), ("scratch", "shop_scratch", Role::Scratch, "scratch_app"), ("test", "shop_test", Role::Test, "test_app")] {
        let env = Environment {
            url: format!("{base}/{dbname}"),
            user: None,
            password: None,
            role,
            allow_clean: false,
            placeholders: [("app_note".to_string(), who.to_string())].into(),
        };
        config::save_environment(&dir, name, &env, true).unwrap();
    }
    let cfg = Config::load(&dir).unwrap();
    for name in ["dev", "scratch", "test"] {
        let c = db::connect(name, cfg.env(name).unwrap()).await.unwrap();
        c.batch_execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;").await.unwrap();
    }
    let write = |n: &str, sql: &str| std::fs::write(dir.join("migrations").join(n), sql).unwrap();

    // Placeholders: each environment gets its own value; built-ins work; a missing one is named.
    write("V1__orders.sql", "create table orders (id bigint primary key, note text);\ncomment on table orders is 'for ${app_note} in ${flyway:defaultSchema}';\n");
    write("V2__total.sql", "alter table orders add column total numeric;\n");
    write("V3__drop_note.sql", "alter table orders drop column note;\n");
    write("R__counter.sql", "create or replace function order_count() returns bigint language sql as 'select count(*) from orders';\n");
    runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    let t = db::connect("test", cfg.env("test").unwrap()).await.unwrap();
    let comment: String = db::row(&t, "select obj_description('public.orders'::regclass)", &[]).await.unwrap().get(0);
    assert_eq!(comment, "for test_app in public");
    let dry = runner::migrate(&cfg, Some("dev"), MigrateOptions { dry_run: true, ..Default::default() }, &quiet).await.unwrap();
    assert!(dry.dry_run_sql.unwrap().contains("'for dev_app in public'"), "dry run shows the filled-in SQL");
    write("V4__oops.sql", "select '${nobody}';\n");
    let err = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap_err().to_string();
    assert!(err.contains("V4__oops.sql uses placeholders with no value: nobody"), "{err}");
    std::fs::remove_file(dir.join("migrations/V4__oops.sql")).unwrap();

    // Re-run repeatables: unchanged R scripts run again only when asked.
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty());
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions { rerun_repeatables: true, ..Default::default() }, &quiet).await.unwrap();
    assert_eq!(r.applied.iter().map(|a| a.script.as_str()).collect::<Vec<_>>(), ["R__counter.sql"]);
    runner::validate_env(&cfg, Some("test")).await.unwrap();

    // Squash up to V2: a B2 script, checked to build the same schema, used by empty databases only.
    let (g, path) = diff::squash(&cfg, Some("2"), "start", None, false, &quiet).await.unwrap();
    assert_eq!(g.file_name, "B2__start.sql");
    assert!(path.unwrap().exists());
    assert!(g.sql.contains("total") && g.sql.contains("note") && !g.sql.contains("order_count"), "V1-V2 only, no repeatables:\n{}", g.sql);
    let r = runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.iter().map(|a| a.script.as_str()).collect::<Vec<_>>(), ["B2__start.sql", "V3__drop_note.sql", "R__counter.sql"]);
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty(), "history databases untouched");
    runner::validate_env(&cfg, Some("test")).await.unwrap();
    assert!(diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap().changes.is_empty(), "dev from B2 matches the migrations");
    let again = diff::squash(&cfg, Some("2"), "start", None, false, &quiet).await.unwrap_err().to_string();
    assert!(again.contains("B2__start.sql already exists"), "{again}");
    std::fs::remove_dir_all(&dir).unwrap();
}
