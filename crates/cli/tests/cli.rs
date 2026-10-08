//! The CLI as a CI pipeline sees it: the real binary, exit codes, one JSON object per command on
//! stdout, logs on stderr, no prompts. Needs Postgres (see crates/core/tests/postgres.rs):
//!   LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432 cargo test -p liftoff-cli -- --include-ignored
//! Paid commands use %USERPROFILE%/.liftoff/dev-license.txt when present (issued with tools/licensegen).

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn liftoff(dir: &Path, args: &[&str], license: Option<&str>) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_liftoff"));
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).env_remove("LIFTOFF_LICENSE").env("LIFTOFF_NO_KEYRING", "1");
    if let Some(l) = license {
        cmd.env("LIFTOFF_LICENSE", l);
    }
    let Output { status, stdout, stderr } = cmd.output().unwrap();
    Run { code: status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&stdout).into(), stderr: String::from_utf8_lossy(&stderr).into() }
}

/// In JSON mode stdout is exactly one JSON object.
fn json(r: &Run) -> serde_json::Value {
    let lines: Vec<&str> = r.stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 1, "one JSON object on stdout, got:\n{}\nstderr:\n{}", r.stdout, r.stderr);
    serde_json::from_str(lines[0]).unwrap()
}

fn reset(base: &str, db: &str) {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let env = liftoff_core::config::Environment { url: format!("{base}/{db}"), user: None, password: None, role: liftoff_core::config::Role::Test, allow_clean: false };
        let c = liftoff_core::db::connect(db, &env).await.unwrap();
        c.batch_execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;").await.unwrap();
    });
}

#[test]
#[ignore = "needs Postgres: set LIFTOFF_TEST_PG"]
fn ci_contract() {
    let base = std::env::var("LIFTOFF_TEST_PG").expect("set LIFTOFF_TEST_PG");
    let license = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".liftoff/dev-license.txt"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string());
    let dir = std::env::temp_dir().join(format!("liftoff-cli-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    reset(&base, "shop_test");
    reset(&base, "shop_scratch");

    assert_eq!(liftoff(&dir, &["init", "--name", "ci"], None).code, 0);
    let toml = std::fs::read_to_string(dir.join("liftoff.toml")).unwrap();
    std::fs::write(
        dir.join("liftoff.toml"),
        format!("{toml}\n[environments.test]\nurl = \"{base}/shop_test\"\nrole = \"test\"\n\n[environments.scratch]\nurl = \"{base}/shop_scratch\"\nrole = \"scratch\"\n"),
    )
    .unwrap();
    std::fs::write(dir.join("migrations/V1__orders.sql"), "create table orders (id int primary key, note text);\n").unwrap();

    // F11-H1: the pipeline, all JSON.
    let r = liftoff(&dir, &["-e", "test", "test-connection", "--output-type", "json"], None);
    assert_eq!((r.code, json(&r)["ok"].as_bool()), (0, Some(true)), "{}", r.stderr);
    let r = liftoff(&dir, &["-e", "test", "validate", "--output-type", "json"], None);
    assert_eq!(r.code, 0, "{}", r.stderr);
    let r = liftoff(&dir, &["-e", "test", "migrate", "--output-type", "json"], None);
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert_eq!(json(&r)["result"]["applied"].as_array().unwrap().len(), 1);
    assert!(r.stderr.contains("Running V1__orders.sql"), "logs go to stderr: {}", r.stderr);
    let r = liftoff(&dir, &["-e", "test", "info", "--output-type", "json"], None);
    assert_eq!(json(&r)["result"][0]["state"], "applied");

    // F11-E1: paid command without a licence; free ones keep working.
    let r = liftoff(&dir, &["-e", "test", "check", "--drift", "--output-type", "json"], None);
    assert_eq!((r.code, json(&r)["error"]["code"].as_str()), (20, Some("LIFTOFF_LICENSE")));

    // F04-N2: an applied script edited afterwards blocks migrate with exit 12 and names the file.
    std::fs::write(dir.join("migrations/V1__orders.sql"), "create table orders (id int primary key, note text, x int);\n").unwrap();
    let r = liftoff(&dir, &["-e", "test", "migrate"], None);
    assert_eq!(r.code, 12, "{}", r.stderr);
    assert!(r.stderr.contains("V1__orders.sql changed after it was applied"), "{}", r.stderr);
    std::fs::write(dir.join("migrations/V1__orders.sql"), "create table orders (id int primary key, note text);\n").unwrap();

    // F09-N1: clean is refused on a test database.
    assert_eq!(liftoff(&dir, &["-e", "test", "clean"], None).code, 2);

    // F11-N1 / F12-N1: unsupported Flyway options are errors, and so is writing to Flyway's table.
    let r = liftoff(&dir, &["-placeholders.owner=x", "-e", "test", "migrate"], None);
    assert!(r.code == 2 && r.stderr.contains("placeholders.owner"), "{}", r.stderr);
    let r = liftoff(&dir, &["-table=flyway_schema_history", "-e", "test", "info"], None);
    assert!(r.code == 2 && r.stderr.contains("import-flyway-history"), "{}", r.stderr);

    // F12-E2: Flyway-style call without a project file.
    let bare = dir.join("bare");
    std::fs::create_dir_all(bare.join("sql")).unwrap();
    let url = format!("-url=jdbc:{}", base.replacen("postgres://", "postgresql://", 1)) + "/shop_test";
    let r = liftoff(&bare, &[&url, "-locations=filesystem:sql", "-outputType=json", "info"], None);
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(json(&r)["result"].as_array().unwrap().iter().any(|i| i["script"] == "V1__orders.sql"), "{}", r.stdout);

    // F08-E1 (paid): a hand change is drift, exit 13, with the report on stdout.
    match &license {
        Some(l) => {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let env = liftoff_core::config::Environment { url: format!("{base}/shop_test"), user: None, password: None, role: liftoff_core::config::Role::Test, allow_clean: false };
                liftoff_core::db::connect("t", &env).await.unwrap().batch_execute("alter table orders add column hotfix int").await.unwrap();
            });
            let r = liftoff(&dir, &["-e", "test", "check", "--drift", "--output-type", "json"], Some(l));
            assert_eq!(r.code, 13, "{}\n{}", r.stdout, r.stderr);
            let v = json(&r);
            assert_eq!(v["error"]["code"], "LIFTOFF_DRIFT");
            assert_eq!(v["result"]["drift"][0]["id"], "table:public.orders");
        }
        None => eprintln!("skipped the paid drift case: no ~/.liftoff/dev-license.txt"),
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
