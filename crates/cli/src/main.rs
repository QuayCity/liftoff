//! `liftoff` CLI: a thin layer over liftoff-core. The CI contract (architecture.md):
//! one JSON object per command on stdout with --output-type=json, logs on stderr,
//! stable exit codes, never prompts.

mod flyway_args;

use clap::{Parser, Subcommand, ValueEnum};
use flyway_args::Adhoc;
use liftoff_core::config::{self, Config};
use liftoff_core::runner::{self, Level, MigrateOptions};
use liftoff_core::checks::{self, CheckOptions};
use liftoff_core::config::{Environment, Role};
use liftoff_core::{diff, flyway, license, Error, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "liftoff", version, about = "Database migrations: write them from your changes, run them everywhere.")]
struct Cli {
    /// Project folder (holds liftoff.toml)
    #[arg(short = 'C', long, global = true, default_value = ".")]
    project_dir: PathBuf,
    /// Environment from liftoff.toml to work on
    #[arg(short, long, global = true)]
    environment: Option<String>,
    #[arg(long, global = true, value_enum, default_value_t = Output::Text)]
    output_type: Output,
    /// Licence string; prefer the LIFTOFF_LICENSE variable in CI
    #[arg(long, global = true, hide_env_values = true)]
    license: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum Output {
    Text,
    Json,
}

#[derive(Subcommand)]
enum Command {
    /// Create liftoff.toml, migrations/ and schema-model/ in the project folder
    Init {
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "postgresql")]
        engine: String,
        /// Convert the folder's flyway.toml or flyway.conf instead of starting empty (the originals stay)
        #[arg(long)]
        from_flyway: bool,
    },
    /// Copy an environment's Flyway history into LiftOff's history table, once
    ImportFlywayHistory {
        /// Flyway's history table
        #[arg(long, default_value = flyway::DEFAULT_TABLE)]
        table: String,
        /// Import even if applied scripts changed since they ran (stores the current files' checksums)
        #[arg(long)]
        accept_edited: bool,
    },
    /// Check that an environment is reachable
    #[command(alias = "testConnection")]
    TestConnection,
    /// List every migration and its state on the environment
    Info,
    /// Run pending migrations
    Migrate {
        /// Also run scripts older than the latest applied version
        #[arg(long)]
        out_of_order: bool,
        /// Stop after this version
        #[arg(long)]
        target: Option<String>,
        /// Print the SQL that would run instead of running it (Pro)
        #[arg(long)]
        dry_run: bool,
        /// Run every script on a database that has tables but no history (normally refused)
        #[arg(long)]
        allow_non_empty: bool,
    },
    /// Undo the latest applied migration with its U script (Pro)
    Undo,
    /// Pre-deploy checks: drift, what the pending scripts change, and the dry-run script (Pro).
    /// With no flags, runs all three. Exits 13 when drift is found.
    Check {
        #[arg(long)]
        drift: bool,
        #[arg(long)]
        changes: bool,
        #[arg(long)]
        dry_run: bool,
        /// Scratch environment rebuilt for the comparison (default: the first with role "scratch")
        #[arg(long)]
        scratch: Option<String>,
        /// Also write a self-contained HTML report to this file
        #[arg(long)]
        report: Option<PathBuf>,
    },
    /// Check applied scripts against the files: failures, edits, missing files, out-of-order scripts
    Validate,
    /// Mark an existing database as already at a version, so older scripts never run there
    Baseline {
        #[arg(long, default_value = "1")]
        version: String,
        #[arg(long, default_value = "baseline")]
        description: String,
    },
    /// Remove failed runs, accept edited scripts, forget scripts whose files were deleted
    Repair,
    /// Erase every object in the project's schemas (only where allow_clean = true, or a scratch database)
    Clean,
    /// Record a pending script as applied without running it (the dev database it was written from)
    MarkApplied {
        /// File name in the migrations folder, e.g. V20261008.1104__add_customers.sql
        script: String,
    },
    /// Create the next migration file to write by hand
    Add {
        #[arg(long)]
        description: String,
        /// A repeatable script (R__), re-run whenever it changes
        #[arg(long)]
        repeatable: bool,
        /// Read the SQL from this file instead of starting empty
        #[arg(long)]
        from_file: Option<PathBuf>,
    },
    /// Write the whole schema of an existing database as the next migration (Pro)
    Capture {
        #[arg(long, default_value = "existing schema")]
        description: String,
        /// Print the script instead of writing it
        #[arg(long)]
        dry_run: bool,
        /// Write a baseline script (B…) that empty databases start from, instead of a V script
        #[arg(long)]
        as_baseline_script: bool,
    },
    /// Create an empty scratch database next to the dev database and save it as an environment
    CreateScratch {
        /// Dev environment (default: the first with role "dev")
        #[arg(long)]
        from: Option<String>,
        /// Name for the new environment
        #[arg(long, default_value = "scratch")]
        name: String,
    },
    /// Compare the dev database with what the migrations build (Pro)
    Diff {
        /// Dev environment (default: the first with role "dev")
        #[arg(long)]
        source: Option<String>,
        /// Scratch environment rebuilt for the comparison (default: the first with role "scratch")
        #[arg(long)]
        scratch: Option<String>,
    },
    /// Write the next migration from the differences (Pro)
    Generate {
        #[arg(long)]
        description: String,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        scratch: Option<String>,
        /// Leave out changes that may lose data (dropped tables/columns, type changes)
        #[arg(long)]
        skip_destructive: bool,
        /// Print the script instead of writing it
        #[arg(long)]
        dry_run: bool,
        /// Also record the new script as applied on the dev database (it already has the change)
        #[arg(long)]
        record_on_dev: bool,
        /// Also write the matching undo script (U…) (Pro)
        #[arg(long)]
        undo: bool,
    },
    /// Show the licence in use
    License,
}

fn main() -> ExitCode {
    let (args, adhoc) = match flyway_args::translate(std::env::args().collect()) {
        Ok(x) => x,
        Err(msg) => {
            eprintln!("error: {msg}");
            return ExitCode::from(2);
        }
    };
    let cli = Cli::parse_from(args);
    let json = cli.output_type == Output::Json;
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    match rt.block_on(run(&cli, &adhoc)) {
        Ok((value, text)) => {
            if json { println!("{}", json!({ "ok": true, "result": value })) } else if !text.is_empty() { println!("{text}") }
            ExitCode::SUCCESS
        }
        Err(e) => {
            // `check` already printed its report (with the error) for drift.
            if matches!(e, Error::Drift(_)) {
                eprintln!("error: {e}");
            } else if json {
                println!("{}", json!({ "ok": false, "error": e.report() }))
            } else {
                eprintln!("error: {e}")
            }
            ExitCode::from(e.exit_code() as u8)
        }
    }
}

fn log(level: Level, msg: &str) {
    match level {
        Level::Info => eprintln!("{msg}"),
        Level::Warn => eprintln!("warning: {msg}"),
    }
}

async fn run(cli: &Cli, adhoc: &Adhoc) -> Result<(Value, String)> {
    let root = &cli.project_dir;
    let env_name = cli.environment.clone().or_else(|| adhoc.url.as_ref().map(|_| "default".to_string()));
    let env = env_name.as_deref();
    match &cli.command {
        Command::Init { name, engine, from_flyway } => {
            let name = name.clone().unwrap_or_else(|| {
                std::fs::canonicalize(root).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "project".into())
            });
            if *from_flyway {
                let r = flyway::convert(root, &name)?;
                let mut text = vec![format!("Converted {} into {}", r.source, r.written.display())];
                text.push(format!("  environments: {}", if r.environments.is_empty() { "none".into() } else { r.environments.join(", ") }));
                text.push(format!("  migrations: {}   schemas: {}", r.migrations, r.schemas.join(", ")));
                text.extend(r.notes.iter().map(|n| format!("  note: {n}")));
                text.extend(r.not_converted.iter().map(|n| format!("  not converted: {n}")));
                text.push(format!("Next, per database: liftoff -e <environment> import-flyway-history --table {}", r.flyway_table));
                return Ok((to(&r)?, text.join("\n")));
            }
            if !flyway::detect(root).is_empty() {
                eprintln!("note: this folder has a Flyway config; `liftoff init --from-flyway` converts it");
            }
            config::init(root, &name, engine)?;
            Ok((json!({ "project": name, "path": root }), format!("Created {} in {}", config::PROJECT_FILE, root.display())))
        }
        Command::TestConnection => {
            let cfg = load(cli, adhoc)?;
            let (name, e) = cfg.pick(env)?;
            let c = liftoff_core::db::connect(&name, e).await?;
            let info = liftoff_core::db::server_info(&c).await?;
            let text = format!("Connected to {name}: {} as {} (PostgreSQL {})", info.database, info.user, info.version);
            Ok((to(&info)?, text))
        }
        Command::Info => {
            let cfg = load(cli, adhoc)?;
            let infos = runner::info(&cfg, env).await?;
            Ok((to(&infos)?, info_table(&infos)))
        }
        Command::Migrate { out_of_order, target, dry_run, allow_non_empty } => {
            let cfg = load(cli, adhoc)?;
            if *dry_run {
                license::require("dry-run", cli.license.as_deref(), Some(root))?;
            }
            let opts = MigrateOptions { out_of_order: *out_of_order, target: target.clone(), dry_run: *dry_run, allow_non_empty: *allow_non_empty };
            let r = runner::migrate(&cfg, env, opts, &log).await?;
            let text = match &r.dry_run_sql {
                Some(sql) => sql.clone(),
                None => format!("Applied {} migration(s) to {} in {} ms", r.applied.len(), r.environment, r.execution_time_ms),
            };
            Ok((to(&r)?, text))
        }
        Command::Undo => {
            let cfg = load(cli, adhoc)?;
            license::require("undo", cli.license.as_deref(), Some(root))?;
            let r = runner::undo(&cfg, env, &log).await?;
            Ok((to(&r)?, String::new()))
        }
        Command::Check { drift, changes, dry_run, scratch, report } => {
            let cfg = load(cli, adhoc)?;
            license::require("check", cli.license.as_deref(), Some(root))?;
            let all = !(*drift || *changes || *dry_run);
            let opts = CheckOptions { drift: all || *drift, changes: all || *changes, dry_run: all || *dry_run };
            let r = checks::check(&cfg, env, scratch.as_deref(), opts, &log).await?;
            if let Some(file) = report {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                std::fs::write(file, checks::report_html(&r, &cfg.project.name, &format!("unix time {now}")))?;
                log(Level::Info, &format!("Report written to {}", file.display()));
            }
            let mut text = Vec::new();
            for (title, list) in [("Drift", &r.drift), ("Pending changes", &r.changes)] {
                if let Some(list) = list {
                    text.push(format!("{title}: {}", if list.is_empty() { "none".to_string() } else { list.len().to_string() }));
                    text.extend(list.iter().map(|c| format!("  {:<8} {}{}", format!("{:?}", c.kind).to_lowercase(), c.name, if c.destructive { "  (may lose data)" } else { "" })));
                }
            }
            if let Some(sql) = &r.dry_run_sql {
                text.push(format!("Dry run:\n{sql}"));
            }
            if r.has_drift() {
                // The report is the useful part: print it, then fail with the drift exit code.
                if cli.output_type == Output::Json {
                    println!("{}", json!({ "ok": false, "result": to(&r)?, "error": Error::Drift(r.environment.clone()).report() }));
                } else {
                    println!("{}", text.join("\n"));
                }
                return Err(Error::Drift(r.environment.clone()));
            }
            Ok((to(&r)?, text.join("\n")))
        }
        Command::ImportFlywayHistory { table, accept_edited } => {
            let cfg = load(cli, adhoc)?;
            let r = flyway::import_history(&cfg, env, table, *accept_edited, &log).await?;
            let mut text = vec![format!("Imported {} row(s) on {}", r.imported, r.environment)];
            text.extend(r.skipped.iter().map(|s| format!("  skipped: {s}")));
            text.extend(r.edited.iter().map(|s| format!("  accepted edit: {s}")));
            text.extend(r.attention.iter().map(|s| format!("  needs attention: {s}")));
            Ok((to(&r)?, text.join("\n")))
        }
        Command::Validate => {
            let cfg = load(cli, adhoc)?;
            let infos = runner::validate_env(&cfg, env).await?;
            Ok((to(&infos)?, format!("{} script(s) checked; no problems", infos.len())))
        }
        Command::Baseline { version, description } => {
            let cfg = load(cli, adhoc)?;
            runner::baseline(&cfg, env, version, description, &log).await?;
            Ok((json!({ "baseline": version }), String::new()))
        }
        Command::Repair => {
            let cfg = load(cli, adhoc)?;
            let r = runner::repair(&cfg, env, &log).await?;
            Ok((to(&r)?, String::new()))
        }
        Command::Clean => {
            let cfg = load(cli, adhoc)?;
            let schemas = runner::clean(&cfg, env, &log).await?;
            Ok((json!({ "cleaned": schemas }), String::new()))
        }
        Command::MarkApplied { script } => {
            let cfg = load(cli, adhoc)?;
            runner::mark_applied(&cfg, env, script, &log).await?;
            Ok((json!({ "recorded": script }), String::new()))
        }
        Command::Add { description, repeatable, from_file } => {
            let cfg = load(cli, adhoc)?;
            let sql = match from_file {
                Some(f) => std::fs::read_to_string(f)?,
                None => String::new(),
            };
            let path = diff::add(&cfg, *repeatable, description, &sql)?;
            Ok((json!({ "written": path }), format!("Created {}", path.display())))
        }
        Command::CreateScratch { from, name } => {
            let cfg = load(cli, adhoc)?;
            let r = diff::create_scratch(&cfg, from.as_deref(), name).await?;
            Ok((to(&r)?, format!("Created database {} and saved it as environment '{}' (role scratch, private)", r.database, r.environment)))
        }
        Command::Capture { description, dry_run, as_baseline_script } => {
            let cfg = load(cli, adhoc)?;
            license::require("generate", cli.license.as_deref(), Some(root))?;
            let g = diff::capture(&cfg, env, description, *as_baseline_script).await?;
            if *dry_run {
                return Ok((to(&g)?, g.sql.clone()));
            }
            let path = diff::save(&cfg, &g.file_name, &g.sql)?;
            let hint = format!(
                "Wrote {}\nThe database it came from already has this schema: run `liftoff baseline --version {}` on it so the script never runs there.",
                path.display(),
                g.version
            );
            Ok((json!({ "written": path, "version": g.version }), hint))
        }
        Command::Diff { source, scratch } => {
            let cfg = load(cli, adhoc)?;
            license::require("diff", cli.license.as_deref(), Some(root))?;
            let cmp = diff::dev_vs_migrations(&cfg, source.as_deref(), scratch.as_deref(), &log).await?;
            let changes = &cmp.changes;
            let text = changes.iter().map(|c| format!("{:<8} {}{}", format!("{:?}", c.kind).to_lowercase(), c.name, if c.destructive { "  (may lose data)" } else { "" })).collect::<Vec<_>>().join("\n");
            Ok((to(&cmp)?, if text.is_empty() { "No differences".into() } else { text }))
        }
        Command::Generate { description, source, scratch, skip_destructive, dry_run, record_on_dev, undo } => {
            let cfg = load(cli, adhoc)?;
            license::require("generate", cli.license.as_deref(), Some(root))?;
            let mut changes = diff::dev_vs_migrations(&cfg, source.as_deref(), scratch.as_deref(), &log).await?.changes;
            if *skip_destructive {
                changes.retain(|c| !c.destructive);
            } else if changes.iter().any(|c| c.destructive) {
                log(Level::Warn, "the script includes changes that may lose data; review it before running, or use --skip-destructive");
            }
            if changes.is_empty() {
                return Ok((json!({ "written": null }), "No differences; nothing written".into()));
            }
            let g = diff::generate(&cfg, &changes, description, *undo)?;
            if *dry_run {
                return Ok((to(&g)?, g.sql.clone()));
            }
            let path = diff::save(&cfg, &g.file_name, &g.sql)?;
            if let Some(u) = &g.undo {
                diff::save(&cfg, &u.file_name, &u.sql)?;
            }
            if *record_on_dev {
                let (dev, _) = cfg.pick_role(source.as_deref(), config::Role::Dev)?;
                runner::mark_applied(&cfg, Some(&dev), &g.file_name, &log).await?;
            }
            Ok((json!({ "written": path, "version": g.version, "changes": changes.len() }), format!("Wrote {}", path.display())))
        }
        Command::License => {
            let st = license::status(cli.license.as_deref(), Some(root))?;
            let text = match &st {
                None => "No licence found. Free commands work without one.".into(),
                Some(s) => format!(
                    "{} ({} seats, {}) valid until {}{}; found in {}",
                    s.license.org, s.license.seats, s.license.edition, s.license.expires,
                    s.grace_days_left.map(|d| format!(", in grace period: {d} days left")).unwrap_or_default(), s.source
                ),
            };
            Ok((to(&st)?, text))
        }
    }
}

fn info_table(infos: &[runner::MigrationInfo]) -> String {
    if infos.is_empty() {
        return "No migrations yet".into();
    }
    let mut out = format!("{:<16} {:<32} {:<15} {:<20} {:>8}\n", "Version", "Description", "State", "Ran on", "Took");
    for i in infos {
        let state = format!("{:?}", i.state).to_lowercase() + if i.checksum_mismatch { " (changed!)" } else { "" };
        out.push_str(&format!(
            "{:<16} {:<32} {:<15} {:<20} {:>8}\n",
            i.version.as_deref().unwrap_or("(repeatable)"),
            truncate(&i.description, 32),
            state,
            i.installed_on.as_deref().unwrap_or(""),
            i.execution_time_ms.map(|m| format!("{m} ms")).unwrap_or_default()
        ));
    }
    out.trim_end().to_string()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n - 1).collect::<String>() + "…" }
}

fn to<T: serde::Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| Error::Config(e.to_string()))
}

/// liftoff.toml with Flyway-style command-line overrides applied. With `-url` and no liftoff.toml,
/// a project is made up on the spot, the way the Flyway CLI works without a config file.
fn load(cli: &Cli, adhoc: &Adhoc) -> Result<Config> {
    let root = &cli.project_dir;
    let mut cfg = if adhoc.url.is_some() && !root.join(config::PROJECT_FILE).exists() {
        Config::adhoc(root, adhoc.locations.as_deref().unwrap_or("sql"))
    } else {
        Config::load(root)?
    };
    if let Some(l) = &adhoc.locations {
        cfg.project.migrations = l.clone();
    }
    if let Some(s) = &adhoc.schemas {
        cfg.project.schemas = s.clone();
    }
    if let Some(d) = &adhoc.default_schema {
        cfg.project.schemas.retain(|s| s != d);
        cfg.project.schemas.insert(0, d.clone());
    }
    if cfg.project.schemas.is_empty() {
        cfg.project.schemas.push("public".into());
    }
    if let Some(t) = &adhoc.table {
        if t.to_lowercase().contains("flyway") {
            return Err(Error::Config(format!(
                "-table={t} is Flyway's history table; LiftOff keeps its own. Import it once with `liftoff import-flyway-history --table {t}`"
            )));
        }
        cfg.project.history_table = t.clone();
    }
    if let Some(url) = &adhoc.url {
        let url = flyway::jdbc_to_url(url)
            .or_else(|| url.starts_with("postgres").then(|| url.clone()))
            .ok_or_else(|| Error::Config(format!("-url={url}: LiftOff supports PostgreSQL for now")))?;
        let name = cli.environment.clone().unwrap_or_else(|| "default".into());
        let old = cfg.environments.get(&name).cloned();
        let env = Environment {
            url,
            user: adhoc.user.clone().or_else(|| old.as_ref().and_then(|o| o.user.clone())),
            password: adhoc.password.clone().or_else(|| old.as_ref().and_then(|o| o.password.clone())),
            role: old.as_ref().map(|o| o.role).unwrap_or(Role::Test),
            allow_clean: adhoc.allow_clean || old.is_some_and(|o| o.allow_clean),
        };
        cfg.environments.insert(name, env);
    }
    Ok(cfg)
}
