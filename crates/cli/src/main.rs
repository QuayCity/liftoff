//! `liftoff` CLI: a thin layer over liftoff-core. The CI contract (architecture.md):
//! one JSON object per command on stdout with --output-type=json, logs on stderr,
//! stable exit codes, never prompts.

use clap::{Parser, Subcommand, ValueEnum};
use liftoff_core::config::{self, Config};
use liftoff_core::runner::{self, Level, MigrateOptions};
use liftoff_core::checks::{self, CheckOptions};
use liftoff_core::{diff, license, Error, Result};
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
    let cli = Cli::parse();
    let json = cli.output_type == Output::Json;
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    match rt.block_on(run(&cli)) {
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

async fn run(cli: &Cli) -> Result<(Value, String)> {
    let root = &cli.project_dir;
    let env = cli.environment.as_deref();
    match &cli.command {
        Command::Init { name, engine } => {
            let name = name.clone().unwrap_or_else(|| {
                std::fs::canonicalize(root).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "project".into())
            });
            config::init(root, &name, engine)?;
            Ok((json!({ "project": name, "path": root }), format!("Created {} in {}", config::PROJECT_FILE, root.display())))
        }
        Command::TestConnection => {
            let cfg = Config::load(root)?;
            let (name, e) = cfg.pick(env)?;
            let c = liftoff_core::db::connect(&name, e).await?;
            let info = liftoff_core::db::server_info(&c).await?;
            let text = format!("Connected to {name}: {} as {} (PostgreSQL {})", info.database, info.user, info.version);
            Ok((to(&info)?, text))
        }
        Command::Info => {
            let cfg = Config::load(root)?;
            let infos = runner::info(&cfg, env).await?;
            Ok((to(&infos)?, info_table(&infos)))
        }
        Command::Migrate { out_of_order, target, dry_run } => {
            let cfg = Config::load(root)?;
            if *dry_run {
                license::require("dry-run", cli.license.as_deref(), Some(root))?;
            }
            let opts = MigrateOptions { out_of_order: *out_of_order, target: target.clone(), dry_run: *dry_run };
            let r = runner::migrate(&cfg, env, opts, &log).await?;
            let text = match &r.dry_run_sql {
                Some(sql) => sql.clone(),
                None => format!("Applied {} migration(s) to {} in {} ms", r.applied.len(), r.environment, r.execution_time_ms),
            };
            Ok((to(&r)?, text))
        }
        Command::Undo => {
            let cfg = Config::load(root)?;
            license::require("undo", cli.license.as_deref(), Some(root))?;
            let r = runner::undo(&cfg, env, &log).await?;
            Ok((to(&r)?, String::new()))
        }
        Command::Check { drift, changes, dry_run, scratch } => {
            let cfg = Config::load(root)?;
            license::require("check", cli.license.as_deref(), Some(root))?;
            let all = !(*drift || *changes || *dry_run);
            let opts = CheckOptions { drift: all || *drift, changes: all || *changes, dry_run: all || *dry_run };
            let r = checks::check(&cfg, env, scratch.as_deref(), opts, &log).await?;
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
        Command::Validate => {
            let cfg = Config::load(root)?;
            let infos = runner::validate_env(&cfg, env).await?;
            Ok((to(&infos)?, format!("{} script(s) checked; no problems", infos.len())))
        }
        Command::Baseline { version, description } => {
            let cfg = Config::load(root)?;
            runner::baseline(&cfg, env, version, description, &log).await?;
            Ok((json!({ "baseline": version }), String::new()))
        }
        Command::Repair => {
            let cfg = Config::load(root)?;
            let r = runner::repair(&cfg, env, &log).await?;
            Ok((to(&r)?, String::new()))
        }
        Command::Clean => {
            let cfg = Config::load(root)?;
            let schemas = runner::clean(&cfg, env, &log).await?;
            Ok((json!({ "cleaned": schemas }), String::new()))
        }
        Command::MarkApplied { script } => {
            let cfg = Config::load(root)?;
            runner::mark_applied(&cfg, env, script, &log).await?;
            Ok((json!({ "recorded": script }), String::new()))
        }
        Command::Add { description, repeatable, from_file } => {
            let cfg = Config::load(root)?;
            let sql = match from_file {
                Some(f) => std::fs::read_to_string(f)?,
                None => String::new(),
            };
            let path = diff::add(&cfg, *repeatable, description, &sql)?;
            Ok((json!({ "written": path }), format!("Created {}", path.display())))
        }
        Command::Capture { description, dry_run } => {
            let cfg = Config::load(root)?;
            license::require("generate", cli.license.as_deref(), Some(root))?;
            let g = diff::capture(&cfg, env, description).await?;
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
            let cfg = Config::load(root)?;
            license::require("diff", cli.license.as_deref(), Some(root))?;
            let changes = diff::dev_vs_migrations(&cfg, source.as_deref(), scratch.as_deref(), &log).await?;
            let text = changes.iter().map(|c| format!("{:<8} {}{}", format!("{:?}", c.kind).to_lowercase(), c.name, if c.destructive { "  (may lose data)" } else { "" })).collect::<Vec<_>>().join("\n");
            Ok((to(&changes)?, if text.is_empty() { "No differences".into() } else { text }))
        }
        Command::Generate { description, source, scratch, skip_destructive, dry_run, record_on_dev, undo } => {
            let cfg = Config::load(root)?;
            license::require("generate", cli.license.as_deref(), Some(root))?;
            let mut changes = diff::dev_vs_migrations(&cfg, source.as_deref(), scratch.as_deref(), &log).await?;
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
