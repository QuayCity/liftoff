//! info (C03) and migrate (C04).

use crate::config::Config;
use crate::db::{self, HistoryRow, NewRow};
use crate::error::{Error, Result};
use crate::migration::{self, Kind, Script, Version};
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Applied,
    Failed,
    /// repeatable whose file changed since it ran; migrate re-runs it
    Outdated,
    /// versioned file older than the latest applied one (out of order); migrate refuses unless --out-of-order
    Ignored,
    /// versioned file at or below the baseline version; never runs
    BelowBaseline,
    /// in the history, file gone
    Missing,
    Baseline,
    /// in the history, newer than any file here (another branch ran it)
    Future,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationInfo {
    pub kind: Kind,
    pub version: Option<String>,
    pub description: String,
    pub script: String,
    pub state: State,
    pub installed_on: Option<String>,
    pub execution_time_ms: Option<i32>,
    /// applied versioned script whose file changed afterwards
    pub checksum_mismatch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
}

/// Progress callback shared by the CLI (stderr) and the desktop (Tauri events).
pub type Log<'a> = &'a (dyn Fn(Level, &str) + Sync);

pub fn compute(scripts: &[Script], rows: &[HistoryRow]) -> Vec<MigrationInfo> {
    let ver = |r: &HistoryRow| r.version.as_deref().and_then(Version::parse);
    let applied_rows: Vec<&HistoryRow> = rows.iter().filter(|r| r.version.is_some() && r.kind != "UNDO_SQL" && r.kind != "BASELINE").collect();
    let baseline_rows: Vec<&HistoryRow> = rows.iter().filter(|r| r.kind == "BASELINE").collect();
    let baseline = baseline_rows.iter().filter_map(|r| ver(r)).max();
    let max_applied = applied_rows.iter().filter(|r| r.success).filter_map(|r| ver(r)).chain(baseline.clone()).max();
    let max_file = scripts.iter().filter(|s| s.kind == Kind::Versioned).filter_map(|s| s.version.clone()).max();

    let row_info = |r: &HistoryRow, kind: Kind, state: State| MigrationInfo {
        kind,
        version: r.version.clone(),
        description: r.description.clone(),
        script: r.script.clone(),
        state,
        installed_on: Some(r.installed_on.clone()),
        execution_time_ms: Some(r.execution_time),
        checksum_mismatch: false,
    };

    let mut versioned: Vec<(Version, MigrationInfo)> = Vec::new();
    for s in scripts.iter().filter(|s| s.kind == Kind::Versioned) {
        let v = s.version.clone().unwrap();
        // Latest row for this version wins (a repaired failure is followed by a success).
        let row = applied_rows.iter().rev().find(|r| ver(r).as_ref() == Some(&v));
        let (state, row) = match row {
            Some(r) if r.success => (State::Applied, Some(*r)),
            Some(r) => (State::Failed, Some(*r)),
            None if baseline.as_ref().is_some_and(|b| v <= *b) => (State::BelowBaseline, None),
            None if max_applied.as_ref().is_some_and(|m| v < *m) => (State::Ignored, None),
            None => (State::Pending, None),
        };
        versioned.push((v.clone(), MigrationInfo {
            kind: Kind::Versioned,
            version: Some(v.text.clone()),
            description: s.description.clone(),
            script: s.file_name.clone(),
            state,
            installed_on: row.map(|r| r.installed_on.clone()),
            execution_time_ms: row.map(|r| r.execution_time),
            checksum_mismatch: row.is_some_and(|r| r.success && r.checksum != Some(s.checksum)),
        }));
    }
    for r in &baseline_rows {
        versioned.push((ver(r).unwrap_or_else(|| Version::parse("0").unwrap()), row_info(r, Kind::Baseline, State::Baseline)));
    }
    let mut seen: Vec<Version> = Vec::new();
    for r in applied_rows.iter().rev() {
        let v = ver(r).unwrap();
        if seen.contains(&v) || versioned.iter().any(|(sv, i)| *sv == v && i.kind == Kind::Versioned) {
            continue;
        }
        seen.push(v.clone());
        let state = if max_file.as_ref().is_none_or(|m| v > *m) { State::Future } else { State::Missing };
        versioned.push((v, row_info(r, Kind::Versioned, state)));
    }
    versioned.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out: Vec<MigrationInfo> = versioned.into_iter().map(|(_, i)| i).collect();
    let repeatable_rows: Vec<&HistoryRow> = rows.iter().filter(|r| r.version.is_none()).collect();
    for s in scripts.iter().filter(|s| s.kind == Kind::Repeatable) {
        let row = repeatable_rows.iter().rev().find(|r| r.description == s.description);
        let state = match row {
            None => State::Pending,
            Some(r) if !r.success => State::Failed,
            Some(r) if r.checksum == Some(s.checksum) => State::Applied,
            Some(_) => State::Outdated,
        };
        out.push(MigrationInfo {
            kind: Kind::Repeatable,
            version: None,
            description: s.description.clone(),
            script: s.file_name.clone(),
            state,
            installed_on: row.map(|r| r.installed_on.clone()),
            execution_time_ms: row.map(|r| r.execution_time),
            checksum_mismatch: false,
        });
    }
    let mut gone: Vec<&HistoryRow> = Vec::new();
    for r in repeatable_rows.iter().rev() {
        if !scripts.iter().any(|s| s.kind == Kind::Repeatable && s.description == r.description) && !gone.iter().any(|g| g.description == r.description) {
            gone.push(r);
        }
    }
    gone.sort_by(|a, b| a.description.cmp(&b.description));
    out.extend(gone.into_iter().map(|r| row_info(r, Kind::Repeatable, State::Missing)));
    out
}

pub async fn info(cfg: &Config, env_name: Option<&str>) -> Result<Vec<MigrationInfo>> {
    let (name, env) = cfg.pick(env_name)?;
    let scripts = migration::scan(&cfg.migrations_dir())?;
    let c = db::connect(&name, env).await?;
    let rows = db::read_history(&c, cfg.history_schema(), &cfg.project.history_table).await?;
    Ok(compute(&scripts, &rows))
}

#[derive(Debug, Default, Serialize)]
pub struct MigrateResult {
    pub environment: String,
    pub applied: Vec<Applied>,
    pub execution_time_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct Applied {
    pub script: String,
    pub version: Option<String>,
    pub execution_time_ms: i32,
    pub transactional: bool,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MigrateOptions {
    /// also run versioned scripts older than the latest applied one
    pub out_of_order: bool,
}

/// Validates, then applies pending versioned scripts in order, then new or changed repeatables.
pub async fn migrate(cfg: &Config, env_name: Option<&str>, opts: MigrateOptions, log: Log<'_>) -> Result<MigrateResult> {
    let started = Instant::now();
    let (name, env) = cfg.pick(env_name)?;
    let scripts = migration::scan(&cfg.migrations_dir())?;
    let c = db::connect(&name, env).await?;
    let info = db::server_info(&c).await?;
    log(Level::Info, &format!("Connected to {name} ({} as {}, PostgreSQL {})", info.database, info.user, info.version));

    let (schema, table) = (cfg.history_schema(), cfg.project.history_table.as_str());
    db::lock(&c, schema, table, || log(Level::Info, "Another run holds the lock on this database; waiting")).await?;
    let result = migrate_locked(&c, cfg, &name, &scripts, opts, log).await;
    // Unlock even on failure; a dropped connection would release it too.
    let _ = db::unlock(&c, schema, table).await;
    let mut result = result?;
    result.execution_time_ms = started.elapsed().as_millis();
    Ok(result)
}

async fn migrate_locked(c: &tokio_postgres::Client, cfg: &Config, name: &str, scripts: &[Script], opts: MigrateOptions, log: Log<'_>) -> Result<MigrateResult> {
    let (schema, table) = (cfg.history_schema(), cfg.project.history_table.as_str());
    db::ensure_history(c, schema, table).await?;
    let rows = db::read_history(c, schema, table).await?;
    let infos = compute(scripts, &rows);

    validate(&infos, opts)?;

    let todo: Vec<&MigrationInfo> = infos
        .iter()
        .filter(|i| match (i.kind, i.state) {
            (Kind::Versioned, State::Pending) => true,
            (Kind::Versioned, State::Ignored) => opts.out_of_order,
            (Kind::Repeatable, State::Pending | State::Outdated) => true,
            _ => false,
        })
        .collect();
    if todo.is_empty() {
        log(Level::Info, &format!("{name} is up to date"));
    }

    let mut result = MigrateResult { environment: name.to_string(), ..Default::default() };
    for i in todo {
        let s = scripts.iter().find(|s| s.file_name == i.script).unwrap();
        let transactional = !migration::needs_no_transaction(&s.sql);
        if !transactional {
            log(Level::Warn, &format!("{} runs outside a transaction; if it fails part-way it cannot be rolled back", s.file_name));
        }
        log(Level::Info, &format!("Running {}", s.file_name));
        let t = Instant::now();
        let outcome = run_script(c, s, transactional, schema, table).await;
        let ms = t.elapsed().as_millis() as i32;
        if let Err(e) = outcome {
            let msg = match &e {
                Error::Db(db) => db_message(db),
                other => other.to_string(),
            };
            if !transactional {
                // Partial changes may remain: record the failure so `repair` is required.
                record(c, s, ms, false, schema, table).await?;
            }
            log(Level::Warn, &format!("{} failed{}", s.file_name, if transactional { "; rolled back" } else { "" }));
            return Err(Error::Migration { script: s.file_name.clone(), msg });
        }
        log(Level::Info, &format!("Applied {} in {ms} ms", s.file_name));
        result.applied.push(Applied { script: s.file_name.clone(), version: s.version.as_ref().map(|v| v.text.clone()), execution_time_ms: ms, transactional });
    }
    Ok(result)
}

/// What `migrate` refuses to run on (also the core of `validate`, C05).
pub fn validate(infos: &[MigrationInfo], opts: MigrateOptions) -> Result<()> {
    let mut problems = Vec::new();
    for i in infos {
        match i.state {
            State::Failed => problems.push(format!("{} failed on a previous run; fix it and run `liftoff repair`", i.script)),
            State::Missing if i.kind == Kind::Versioned => problems.push(format!("{} was applied but the file is missing", i.script)),
            State::Ignored if !opts.out_of_order => {
                problems.push(format!("{} is older than the latest applied version; use --out-of-order to run it", i.script))
            }
            _ => {}
        }
        if i.checksum_mismatch {
            problems.push(format!("{} changed after it was applied (checksum mismatch)", i.script));
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(Error::Validate(problems.join("\n"))) }
}

async fn run_script(c: &tokio_postgres::Client, s: &Script, transactional: bool, schema: &str, table: &str) -> Result<()> {
    if transactional {
        // One transaction for script + history row: both land or neither does.
        c.batch_execute("BEGIN").await?;
        let t = Instant::now();
        let run = async {
            c.batch_execute(&s.sql).await?;
            record(c, s, t.elapsed().as_millis() as i32, true, schema, table).await
        }
        .await;
        match run {
            Ok(()) => c.batch_execute("COMMIT").await.map_err(Error::from),
            Err(e) => {
                let _ = c.batch_execute("ROLLBACK").await;
                Err(e)
            }
        }
    } else {
        let t = Instant::now();
        for stmt in migration::split_statements(&s.sql) {
            c.batch_execute(&stmt).await?;
        }
        record(c, s, t.elapsed().as_millis() as i32, true, schema, table).await
    }
}

async fn record(c: &tokio_postgres::Client, s: &Script, ms: i32, success: bool, schema: &str, table: &str) -> Result<()> {
    db::insert_history(c, schema, table, NewRow {
        version: s.version.as_ref().map(|v| v.text.as_str()),
        description: &s.description,
        kind: "SQL",
        script: &s.file_name,
        checksum: Some(s.checksum),
        execution_time: ms,
        success,
    })
    .await
}

/// Postgres error with its position, e.g. `relation "x" already exists (line 3)`.
pub fn db_message(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(d) => {
            let mut m = format!("{}: {}", d.severity(), d.message());
            if let Some(h) = d.hint() { m.push_str(&format!(" (hint: {h})")); }
            m
        }
        None => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn script(name: &str, sum: i32) -> Script {
        let (kind, v, d) = migration::parse_name(name).unwrap();
        Script { kind, version: v.and_then(|v| Version::parse(&v)), description: d, file_name: name.into(), path: PathBuf::new(), checksum: sum, sql: String::new() }
    }
    fn row(v: Option<&str>, desc: &str, name: &str, sum: i32, ok: bool, kind: &str) -> HistoryRow {
        HistoryRow { installed_rank: 0, version: v.map(Into::into), description: desc.into(), kind: kind.into(), script: name.into(), checksum: Some(sum), installed_by: "me".into(), installed_on: "t".into(), execution_time: 1, success: ok }
    }

    #[test]
    fn states() {
        let scripts = [script("V1__a.sql", 1), script("V2__b.sql", 2), script("V3__c.sql", 3), script("V5__e.sql", 5), script("R__v.sql", 9), script("R__w.sql", 10)];
        let rows = [
            row(Some("1"), "a", "V1__a.sql", 1, true, "SQL"),
            row(Some("3"), "c", "V3__c.sql", 33, true, "SQL"), // file edited after apply
            row(Some("4"), "d", "V4__d.sql", 4, true, "SQL"),  // file deleted
            row(None, "v", "R__v.sql", 8, true, "SQL"),         // repeatable changed
            row(None, "w", "R__w.sql", 10, true, "SQL"),
            row(Some("9"), "z", "V9__z.sql", 9, true, "SQL"),  // from another branch
        ];
        let info = compute(&scripts, &rows);
        let state = |s: &str| info.iter().find(|i| i.script == s).unwrap().state;
        assert_eq!(state("V1__a.sql"), State::Applied);
        assert_eq!(state("V2__b.sql"), State::Ignored);
        assert_eq!(state("V3__c.sql"), State::Applied);
        assert!(info.iter().find(|i| i.script == "V3__c.sql").unwrap().checksum_mismatch);
        assert_eq!(state("V4__d.sql"), State::Missing);
        assert_eq!(state("V5__e.sql"), State::Ignored);
        assert_eq!(state("V9__z.sql"), State::Future);
        assert_eq!(state("R__v.sql"), State::Outdated);
        assert_eq!(state("R__w.sql"), State::Applied);
        let err = validate(&info, MigrateOptions::default()).unwrap_err().to_string();
        assert!(err.contains("V3__c.sql changed"), "{err}");
        assert!(err.contains("V4__d.sql was applied but the file is missing"), "{err}");
        assert!(err.contains("V2__b.sql is older"), "{err}");
    }

    #[test]
    fn fresh_database_is_all_pending_in_order() {
        let scripts = [script("V2__b.sql", 2), script("V10__c.sql", 3), script("V1__a.sql", 1)];
        let mut scripts = scripts.to_vec();
        scripts.sort_by(|a, b| a.version.cmp(&b.version));
        let info = compute(&scripts, &[]);
        assert_eq!(info.iter().map(|i| i.script.as_str()).collect::<Vec<_>>(), ["V1__a.sql", "V2__b.sql", "V10__c.sql"]);
        assert!(info.iter().all(|i| i.state == State::Pending));
        validate(&info, MigrateOptions::default()).unwrap();
    }

    #[test]
    fn baseline_hides_older_scripts_without_complaint() {
        let scripts = [script("V1__a.sql", 1), script("V2__b.sql", 2)];
        let rows = [row(Some("1"), "<< baseline >>", "<< baseline >>", 0, true, "BASELINE")];
        let info = compute(&scripts, &rows);
        assert_eq!(info.iter().find(|i| i.script == "V1__a.sql").unwrap().state, State::BelowBaseline);
        assert_eq!(info.iter().filter(|i| i.state == State::Baseline).count(), 1);
        validate(&info, MigrateOptions::default()).unwrap();
        assert_eq!(info.iter().find(|i| i.script == "V2__b.sql").unwrap().state, State::Pending);
    }
}
