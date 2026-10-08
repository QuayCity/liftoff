//! `liftoff` CLI: a thin layer over liftoff-core. The CI contract (architecture.md):
//! one JSON object per command on stdout with --output-type=json, logs on stderr,
//! stable exit codes, never prompts.

use clap::{Parser, Subcommand, ValueEnum};
use liftoff_core::config::{self, Config};
use liftoff_core::runner::{self, Level, MigrateOptions};
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
            if json { println!("{}", json!({ "ok": false, "error": e.report() })) } else { eprintln!("error: {e}") }
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
        Command::Migrate { out_of_order } => {
            let cfg = Config::load(root)?;
            let r = runner::migrate(&cfg, env, MigrateOptions { out_of_order: *out_of_order }, &log).await?;
            let text = format!("Applied {} migration(s) to {} in {} ms", r.applied.len(), r.environment, r.execution_time_ms);
            Ok((to(&r)?, text))
        }
        Command::Diff { source, scratch } => {
            let cfg = Config::load(root)?;
            license::require("diff", cli.license.as_deref(), Some(root))?;
            let changes = diff::dev_vs_migrations(&cfg, source.as_deref(), scratch.as_deref(), &log).await?;
            let text = changes.iter().map(|c| format!("{:<8} {}{}", format!("{:?}", c.kind).to_lowercase(), c.name, if c.destructive { "  (may lose data)" } else { "" })).collect::<Vec<_>>().join("\n");
            Ok((to(&changes)?, if text.is_empty() { "No differences".into() } else { text }))
        }
        Command::Generate { description, source, scratch, skip_destructive, dry_run } => {
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
            let g = diff::generate(&cfg, &changes, description)?;
            if *dry_run {
                return Ok((to(&g)?, g.sql.clone()));
            }
            let path = diff::save(&cfg, &g.file_name, &g.sql)?;
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
