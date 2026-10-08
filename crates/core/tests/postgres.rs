//! End-to-end against a real Postgres. Needs three empty databases on one server:
//!   docker run -d --name liftoff-pg -e POSTGRES_PASSWORD=liftoff -p 55432:5432 postgres:16-alpine
//!   (create databases shop_dev, shop_scratch, shop_test)
//!   LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432 cargo test -p liftoff-core -- --include-ignored

use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::runner::{self, Level, MigrateOptions, State};
use liftoff_core::checks::{self, CheckOptions};
use liftoff_core::{db, diff, flyway, Error};
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
         create table customers (id bigint generated always as identity primary key, \"Name\" text not null unique,
                                 created_at timestamptz default now(), check (length(\"Name\") > 0));
         alter table orders add column customer_id bigint references customers(id);
         alter table orders add primary key (id);
         create index orders_customer_idx on orders (customer_id) where customer_id is not null;
         create type mood as enum ('sad', 'ok', 'happy');
         alter table customers add column mood mood not null default 'ok';
         create sequence invoice_no start 1000;
         create function tax(amount numeric) returns numeric language sql immutable as $$ select amount * 0.21 $$;
         create view order_totals as select id, total, tax(total) as vat from orders;
         create view big_orders as select id from order_totals where total > 100;
         create extension if not exists pgcrypto;
         create domain email as text check (value like '%@%');
         alter table customers add column contact email;
         create table events (id bigint, at timestamptz not null, primary key (id, at)) partition by range (at);
         create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
         create index events_at_idx on events (at);
         create function touch() returns trigger language plpgsql as $$ begin new.created_at := now(); return new; end $$;
         create trigger customers_touch before insert on customers for each row execute function touch();
         create materialized view order_counts as select count(*) as n from orders;
         create unique index order_counts_n on order_counts (n);
         do $$ begin if not exists (select from pg_roles where rolname = 'liftoff_reader') then create role liftoff_reader; end if; end $$;
         grant select on orders to liftoff_reader;
         grant select on order_totals to liftoff_reader;
         comment on table customers is 'People who buy';
         comment on column orders.note is 'Free text';",
    )
    .await
    .unwrap();
    let changes = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap().changes;
    let mut ids: Vec<&str> = changes.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, [
        "comment:COLUMN public.orders.note", "comment:TABLE public.customers", "domain:public.email", "extension:pgcrypto",
        "function:public.tax(amount numeric)", "function:public.touch()", "grant:TABLE public.orders",
        "sequence:public.invoice_no", "table:public.customers", "table:public.events", "table:public.events_2026", "table:public.orders",
        "trigger:public.customers.customers_touch", "type:public.mood", "view:public.big_orders", "view:public.order_counts", "view:public.order_totals",
    ], "{changes:#?}");
    // The new view's grant travels with the view, not as a separate change.
    assert!(changes.iter().find(|c| c.id == "view:public.order_totals").unwrap().sql.contains("GRANT SELECT ON TABLE public.order_totals TO liftoff_reader"));
    assert!(changes.iter().all(|c| c.after.is_some()), "every change carries its after-DDL");
    let g = diff::generate(&cfg, &changes, "customers and totals", true).unwrap();
    let u = g.undo.as_ref().unwrap();
    assert!(u.file_name.starts_with('U') && u.sql.contains("DROP TABLE IF EXISTS public.customers;"), "{}", u.sql);
    diff::save(&cfg, &u.file_name, &u.sql).unwrap();
    assert!(g.file_name.starts_with('V') && g.file_name.ends_with("__customers_and_totals.sql"), "{}", g.file_name);
    diff::save(&cfg, &g.file_name, &g.sql).unwrap();
    assert!(diff::save(&cfg, &g.file_name, &g.sql).is_err(), "never overwrites");
    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.len(), 1);
    let after = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap().changes;
    assert!(after.is_empty(), "round trip left differences: {after:#?}\n--- script ---\n{}", g.sql);

    // 6-nc. Objects the diff does not compare are reported, not silently skipped.
    d.batch_execute("create policy everyone on orders using (true)").await.unwrap();
    let cmp = diff::dev_vs_migrations(&cfg, None, None, &quiet).await.unwrap();
    assert!(cmp.changes.is_empty(), "{:#?}", cmp.changes);
    assert_eq!(cmp.not_compared, ["row-level security policies: 1 in dev, 0 in the scripts"]);
    d.batch_execute("drop policy everyone on orders").await.unwrap();

    // 6a. Undo, dry run, changes report, redo, drift.
    let both = CheckOptions { drift: true, changes: true, dry_run: false };
    let report = checks::check(&cfg, Some("test"), None, both, &quiet).await.unwrap();
    assert!(!report.has_drift(), "freshly migrated: {:#?}", report.drift);
    assert!(report.changes.as_ref().unwrap().is_empty(), "nothing pending");

    let undone = runner::undo(&cfg, Some("test"), &quiet).await.unwrap();
    assert_eq!(undone.script, u.file_name);
    let state_of = |infos: &[runner::MigrationInfo], s: &str| infos.iter().find(|i| i.script == s).map(|i| i.state);
    assert_eq!(state_of(&runner::info(&cfg, Some("test")).await.unwrap(), &g.file_name), Some(State::Pending));
    let report = checks::check(&cfg, Some("test"), None, CheckOptions { drift: true, changes: true, dry_run: true }, &quiet).await.unwrap();
    assert!(!report.has_drift(), "undo restores what the earlier scripts built: {:#?}", report.drift);
    assert_eq!(report.changes.as_ref().unwrap().len(), changes.len(), "the pending script changes what dev changed");
    let dry = report.dry_run_sql.unwrap();
    assert!(dry.contains(&g.file_name) && dry.contains("BEGIN;") && dry.contains("INSERT INTO public.liftoff_schema_history"), "{dry}");
    assert_eq!(state_of(&runner::info(&cfg, Some("test")).await.unwrap(), &g.file_name), Some(State::Pending), "dry run changes nothing");

    let r = runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap();
    assert_eq!(r.applied.len(), 1, "redo after undo");
    c.batch_execute("alter table orders add column hotfix int").await.unwrap();
    let report = checks::check(&cfg, Some("test"), None, CheckOptions { drift: true, ..Default::default() }, &quiet).await.unwrap();
    let drift = report.drift.unwrap();
    assert_eq!(drift.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["table:public.orders"], "{drift:#?}");
    assert!(drift[0].sql.contains("ADD COLUMN hotfix integer"), "{}", drift[0].sql);
    c.batch_execute("alter table orders drop column hotfix").await.unwrap();

    // 6b. Dev already has the generated change: record it there instead of running it.
    let state_on = |infos: &[runner::MigrationInfo], s: &str| infos.iter().find(|i| i.script == s).map(|i| i.state);
    runner::mark_applied(&cfg, Some("dev"), &g.file_name, &quiet).await.unwrap();
    assert_eq!(state_on(&runner::info(&cfg, Some("dev")).await.unwrap(), &g.file_name), Some(State::Applied));
    assert!(runner::migrate(&cfg, Some("dev"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty());
    assert!(runner::mark_applied(&cfg, Some("dev"), &g.file_name, &quiet).await.is_err(), "only pending scripts");

    // 6b2. Capture: the whole dev schema as one script; on an empty database it rebuilds dev exactly.
    let cap = diff::capture(&cfg, Some("dev"), "existing schema").await.unwrap();
    assert!(cap.sql.contains("CREATE TABLE public.customers") && cap.sql.contains("FOREIGN KEY"), "{}", cap.sql);
    runner::clean(&cfg, Some("scratch"), &quiet).await.unwrap();
    let sc = db::connect("scratch", cfg.env("scratch").unwrap()).await.unwrap();
    sc.batch_execute(&cap.sql).await.unwrap();
    let dv = db::connect("dev", cfg.env("dev").unwrap()).await.unwrap();
    let table = &cfg.project.history_table;
    let left = diff::diff(&diff::introspect(&dv, &cfg.project.schemas, table).await.unwrap(), &diff::introspect(&sc, &cfg.project.schemas, table).await.unwrap());
    assert!(left.is_empty(), "capture round trip left differences: {left:#?}");

    // 6b3. Hand-written scripts get the next version (or R__ for repeatables).
    let added = diff::add(&cfg, false, "fix totals", "").unwrap();
    let name = added.file_name().unwrap().to_string_lossy().to_string();
    assert!(name.starts_with('V') && name.ends_with("__fix_totals.sql"), "{name}");
    assert!(diff::add(&cfg, true, "totals view", "select 1;").unwrap().ends_with("R__totals_view.sql"));
    assert!(diff::add(&cfg, true, "totals view", "select 1;").is_err(), "never overwrites");
    std::fs::remove_file(&added).unwrap();
    std::fs::remove_file(dir.join("migrations/R__totals_view.sql")).unwrap();

    // 6c. Repair: a failed non-transactional script, an edited file and a deleted file.
    write(&dir, "V900__bad_index.sql", "create index concurrently bad_idx on no_such_table (x);\n");
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.is_err());
    assert_eq!(state_on(&runner::info(&cfg, Some("test")).await.unwrap(), "V900__bad_index.sql"), Some(State::Failed));
    std::fs::remove_file(dir.join("migrations/V900__bad_index.sql")).unwrap();
    write(&dir, "V1__orders.sql", "-- reformatted after it ran\ncreate table orders (id serial, note text);\n");
    std::fs::remove_file(dir.join("migrations/V2__index.sql")).unwrap();
    let err = runner::validate_env(&cfg, Some("test")).await.unwrap_err().to_string();
    assert!(err.contains("V900__bad_index.sql failed") && err.contains("V1__orders.sql changed") && err.contains("V2__index.sql was applied"), "{err}");
    let report = runner::repair(&cfg, Some("test"), &quiet).await.unwrap();
    assert_eq!((report.removed_failed, report.realigned, report.forgotten), (vec!["V900__bad_index.sql".to_string()], vec!["V1__orders.sql".to_string()], vec!["V2__index.sql".to_string()]));
    runner::validate_env(&cfg, Some("test")).await.unwrap();

    // 6d. Clean is refused on a test database, allowed on scratch; baseline skips old scripts.
    assert!(runner::clean(&cfg, Some("test"), &quiet).await.unwrap_err().to_string().contains("allow_clean"));
    runner::clean(&cfg, Some("scratch"), &quiet).await.unwrap();
    let sc = db::connect("scratch", cfg.env("scratch").unwrap()).await.unwrap();
    sc.batch_execute("create table orders (id serial, note text);").await.unwrap();
    runner::baseline(&cfg, Some("scratch"), "1", "existing schema", &quiet).await.unwrap();
    assert!(runner::baseline(&cfg, Some("scratch"), "1", "again", &quiet).await.is_err(), "baseline needs an empty history");
    let r = runner::migrate(&cfg, Some("scratch"), MigrateOptions::default(), &quiet).await.unwrap();
    assert!(r.applied.iter().all(|a| a.script != "V1__orders.sql"), "{:?}", r.applied);
    assert_eq!(state_on(&runner::info(&cfg, Some("scratch")).await.unwrap(), "V1__orders.sql"), Some(State::BelowBaseline));

    // 8. One-time import of a Flyway history table.
    reset(&cfg, "test").await;
    let mut fw = cfg.clone();
    fw.project.history_table = "flyway_schema_history".into();
    let tc = db::connect("test", cfg.env("test").unwrap()).await.unwrap();
    db::ensure_history(&tc, "public", "flyway_schema_history").await.unwrap();
    tc.batch_execute("insert into flyway_schema_history values (0, '0', '<< schema creation >>', 'SCHEMA', '\"public\"', null, 'me', now(), 0, true)").await.unwrap();
    runner::migrate(&fw, Some("test"), MigrateOptions { out_of_order: true, ..Default::default() }, &quiet).await.unwrap();
    let flyway_rows = db::read_history(&tc, "public", "flyway_schema_history").await.unwrap().len();

    write(&dir, "V1__orders.sql", "-- edited after it ran\ncreate table orders (id serial, note text);\n");
    let err = flyway::import_history(&cfg, Some("test"), "flyway_schema_history", false, &quiet).await.unwrap_err().to_string();
    assert!(err.contains("V1__orders.sql") && err.contains("--accept-edited"), "{err}");
    assert!(db::read_history(&tc, "public", &cfg.project.history_table).await.unwrap().is_empty(), "a refused import writes nothing");
    write(&dir, "V1__orders.sql", "-- reformatted after it ran\ncreate table orders (id serial, note text);\n");

    let imp = flyway::import_history(&cfg, Some("test"), "flyway_schema_history", false, &quiet).await.unwrap();
    assert_eq!((imp.imported, imp.skipped.len()), (flyway_rows - 1, 1), "{imp:#?}");
    runner::validate_env(&cfg, Some("test")).await.unwrap();
    assert!(runner::migrate(&cfg, Some("test"), MigrateOptions::default(), &quiet).await.unwrap().applied.is_empty(), "nothing re-runs after an import");
    assert_eq!(db::read_history(&tc, "public", "flyway_schema_history").await.unwrap().len(), flyway_rows, "Flyway's table is left alone");
    assert!(flyway::import_history(&cfg, Some("test"), "flyway_schema_history", false, &quiet).await.is_err(), "runs once");

    // 7. Refuses to rebuild a non-scratch database.
    let err = diff::dev_vs_migrations(&cfg, Some("dev"), Some("test"), &quiet).await.unwrap_err();
    assert!(err.to_string().contains("refusing"), "{err}");

    std::fs::remove_dir_all(&dir).unwrap();
}
