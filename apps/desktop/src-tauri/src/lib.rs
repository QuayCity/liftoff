//! Tauri commands: each maps 1:1 to a liftoff-core function and returns the same JSON
//! shape as `liftoff --output-type=json` (architecture.md "API").

use liftoff_core::config::{self, Config, Environment, Role};
use liftoff_core::error::ErrorReport;
use liftoff_core::runner::{self, Level, MigrateOptions};
use liftoff_core::checks::{self, CheckOptions};
use liftoff_core::{db, diff, flyway, license, Error};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

type R<T> = Result<T, ErrorReport>;

fn rep(e: Error) -> ErrorReport {
    e.report()
}

#[derive(Serialize)]
struct EnvView {
    name: String,
    role: Role,
    /// the URL with any password removed
    url: String,
    user: Option<String>,
    has_password: bool,
    allow_clean: bool,
}

#[derive(Serialize)]
struct ProjectView {
    root: PathBuf,
    name: String,
    engine: String,
    schemas: Vec<String>,
    migrations: String,
    history_table: String,
    filters: Vec<config::Filter>,
    environments: Vec<EnvView>,
    license: Option<license::Status>,
    license_error: Option<String>,
}

fn redact(url: &str) -> String {
    // postgres://user:secret@host -> postgres://user@host
    match (url.find("://"), url.rfind('@')) {
        (Some(s), Some(at)) if at > s => {
            let creds = &url[s + 3..at];
            let user = creds.split(':').next().unwrap_or("");
            format!("{}{}{}", &url[..s + 3], user, &url[at..])
        }
        _ => url.to_string(),
    }
}

fn view(cfg: &Config) -> ProjectView {
    let (license, license_error) = match license::status(None, Some(&cfg.root)) {
        Ok(s) => (s, None),
        Err(e) => (None, Some(e.to_string())),
    };
    ProjectView {
        root: cfg.root.clone(),
        name: cfg.project.name.clone(),
        engine: cfg.project.engine.clone(),
        schemas: cfg.project.schemas.clone(),
        migrations: cfg.project.migrations.clone(),
        history_table: cfg.project.history_table.clone(),
        filters: cfg.project.filters.clone(),
        environments: cfg
            .environments
            .iter()
            .map(|(n, e)| EnvView {
                name: n.clone(),
                role: e.role,
                url: redact(&e.url),
                user: e.user.clone(),
                has_password: e.password.is_some() || redact(&e.url) != e.url,
                allow_clean: e.allow_clean,
            })
            .collect(),
        license,
        license_error,
    }
}

fn load(path: &str) -> R<Config> {
    Config::load(Path::new(path)).map_err(rep)
}

/* ---------- recent projects: one JSON file in the app config dir ---------- */

#[derive(Serialize, Deserialize, Clone)]
struct Recent {
    name: String,
    path: String,
    exists: bool,
}

fn recent_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

fn remember(app: &AppHandle, name: &str, path: &Path) {
    let Some(file) = recent_file(app) else { return };
    let mut list: Vec<Recent> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let path = path.display().to_string();
    list.retain(|r| r.path != path);
    list.insert(0, Recent { name: name.into(), path, exists: true });
    list.truncate(10);
    let _ = std::fs::create_dir_all(file.parent().unwrap());
    let _ = std::fs::write(&file, serde_json::to_vec_pretty(&list).unwrap());
}

#[tauri::command]
fn recent_projects(app: AppHandle) -> Vec<Recent> {
    let Some(file) = recent_file(&app) else { return vec![] };
    let list: Vec<Recent> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    list.into_iter().map(|r| Recent { exists: Path::new(&r.path).join(config::PROJECT_FILE).exists(), ..r }).collect()
}

#[tauri::command]
fn recent_forget(app: AppHandle, path: String) {
    let Some(file) = recent_file(&app) else { return };
    let mut list: Vec<Recent> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    list.retain(|r| r.path != path);
    let _ = std::fs::write(&file, serde_json::to_vec_pretty(&list).unwrap());
}

/* ---------- F01: projects and environments ---------- */

#[tauri::command]
fn project_init(app: AppHandle, path: String, name: String) -> R<ProjectView> {
    config::init(Path::new(&path), &name, "postgresql").map_err(rep)?;
    project_open(app, path)
}

#[tauri::command]
fn project_open(app: AppHandle, path: String) -> R<ProjectView> {
    let root = Path::new(&path);
    if !root.join(config::PROJECT_FILE).exists() && !flyway::detect(root).is_empty() {
        // The UI offers the conversion for this code.
        return Err(ErrorReport { code: "LIFTOFF_FLYWAY_PROJECT", exit_code: 2, message: "This folder has a Flyway project. Convert its settings to open it in LiftOff.".into() });
    }
    let cfg = load(&path)?;
    remember(&app, &cfg.project.name, &cfg.root);
    Ok(view(&cfg))
}

#[derive(Serialize)]
struct Converted {
    report: flyway::ConvertReport,
    project: ProjectView,
}

#[tauri::command]
fn project_convert_flyway(app: AppHandle, path: String) -> R<Converted> {
    let root = Path::new(&path);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let report = flyway::convert(root, &name).map_err(rep)?;
    let project = project_open(app, path)?;
    Ok(Converted { report, project })
}

#[tauri::command]
async fn history_import(app: AppHandle, path: String, env: String, table: String, accept_edited: bool) -> R<flyway::HistoryImport> {
    flyway::import_history(&load(&path)?, Some(&env), &table, accept_edited, &emitter(app)).await.map_err(rep)
}

#[derive(Deserialize)]
struct EnvInput {
    url: String,
    user: Option<String>,
    password: Option<String>,
    role: Role,
    allow_clean: bool,
}

impl EnvInput {
    fn into_env(self) -> Environment {
        let blank = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
        Environment { url: self.url.trim().to_string(), user: blank(self.user), password: blank(self.password), role: self.role, allow_clean: self.allow_clean }
    }
}

#[tauri::command]
fn env_save(path: String, name: String, env: EnvInput, shared: bool) -> R<ProjectView> {
    let mut env = env.into_env();
    if env.password.is_none() {
        // Editing without retyping the password keeps the stored one.
        if let Ok(cfg) = load(&path) && let Some(old) = cfg.environments.get(&name) {
            env.password = old.password.clone();
        }
    }
    config::save_environment(Path::new(&path), &name, &env, shared).map_err(rep)?;
    Ok(view(&load(&path)?))
}

#[tauri::command]
async fn env_test(path: String, name: String) -> R<db::ServerInfo> {
    let cfg = load(&path)?;
    let c = db::connect(&name, cfg.env(&name).map_err(rep)?).await.map_err(rep)?;
    db::server_info(&c).await.map_err(rep)
}

/// Test from the connection dialog before anything is saved.
#[tauri::command]
async fn env_test_draft(env: EnvInput) -> R<db::ServerInfo> {
    let c = db::connect("new environment", &env.into_env()).await.map_err(rep)?;
    db::server_info(&c).await.map_err(rep)
}

/* ---------- F04: run ---------- */

#[derive(Clone, Serialize)]
struct LogEvent {
    level: Level,
    message: String,
}

#[tauri::command]
async fn migrations_info(path: String, env: String) -> R<Vec<runner::MigrationInfo>> {
    runner::info(&load(&path)?, Some(&env)).await.map_err(rep)
}

#[tauri::command]
async fn migrate(app: AppHandle, path: String, env: String, out_of_order: bool, allow_non_empty: bool) -> R<runner::MigrateResult> {
    let cfg = load(&path)?;
    let log = emitter(app);
    runner::migrate(&cfg, Some(&env), MigrateOptions { out_of_order, allow_non_empty, ..Default::default() }, &log).await.map_err(rep)
}

fn emitter(app: AppHandle) -> impl Fn(Level, &str) + Sync {
    move |level: Level, msg: &str| {
        let _ = app.emit("run-log", LogEvent { level, message: msg.to_string() });
    }
}

#[tauri::command]
async fn validate(path: String, env: String) -> R<Vec<runner::MigrationInfo>> {
    runner::validate_env(&load(&path)?, Some(&env)).await.map_err(rep)
}

#[tauri::command]
async fn baseline(app: AppHandle, path: String, env: String, version: String, description: String) -> R<()> {
    runner::baseline(&load(&path)?, Some(&env), &version, &description, &emitter(app)).await.map_err(rep)
}

#[tauri::command]
async fn repair(app: AppHandle, path: String, env: String) -> R<runner::RepairReport> {
    runner::repair(&load(&path)?, Some(&env), &emitter(app)).await.map_err(rep)
}

#[tauri::command]
async fn clean(app: AppHandle, path: String, env: String) -> R<Vec<String>> {
    runner::clean(&load(&path)?, Some(&env), &emitter(app)).await.map_err(rep)
}

#[tauri::command]
async fn mark_applied(app: AppHandle, path: String, env: String, script: String) -> R<()> {
    runner::mark_applied(&load(&path)?, Some(&env), &script, &emitter(app)).await.map_err(rep)
}

/* ---------- F03: changes (Pro) ---------- */

#[tauri::command]
async fn changes_diff(app: AppHandle, path: String) -> R<diff::Comparison> {
    let cfg = load(&path)?;
    license::require("diff", None, Some(&cfg.root)).map_err(rep)?;
    let log = emitter(app);
    diff::dev_vs_migrations(&cfg, None, None, &log).await.map_err(rep)
}

#[tauri::command]
fn migration_generate(path: String, changes: Vec<diff::Change>, description: String, with_undo: bool) -> R<diff::Generated> {
    let cfg = load(&path)?;
    license::require("generate", None, Some(&cfg.root)).map_err(rep)?;
    diff::generate(&cfg, &changes, &description, with_undo).map_err(rep)
}

#[tauri::command]
async fn undo(app: AppHandle, path: String, env: String) -> R<runner::Applied> {
    let cfg = load(&path)?;
    license::require("undo", None, Some(&cfg.root)).map_err(rep)?;
    runner::undo(&cfg, Some(&env), &emitter(app)).await.map_err(rep)
}

#[tauri::command]
async fn check(app: AppHandle, path: String, env: String, drift: bool, changes: bool, dry_run: bool) -> R<checks::CheckReport> {
    let cfg = load(&path)?;
    license::require("check", None, Some(&cfg.root)).map_err(rep)?;
    checks::check(&cfg, Some(&env), None, CheckOptions { drift, changes, dry_run }, &emitter(app)).await.map_err(rep)
}

#[tauri::command]
fn migration_save(path: String, file_name: String, sql: String) -> R<PathBuf> {
    diff::save(&load(&path)?, &file_name, &sql).map_err(rep)
}

/* ---------- S09: scripts ---------- */

#[derive(Serialize)]
struct ScriptView {
    kind: liftoff_core::migration::Kind,
    version: Option<String>,
    description: String,
    file_name: String,
    sql: String,
}

#[tauri::command]
fn scripts_list(path: String) -> R<Vec<ScriptView>> {
    let cfg = load(&path)?;
    let scripts = liftoff_core::migration::scan(&cfg.migrations_dir()).map_err(rep)?;
    Ok(scripts
        .into_iter()
        .map(|s| ScriptView { kind: s.kind, version: s.version.map(|v| v.text), description: s.description, file_name: s.file_name, sql: s.sql })
        .collect())
}

#[tauri::command]
fn script_add(path: String, repeatable: bool, description: String, sql: String) -> R<PathBuf> {
    diff::add(&load(&path)?, repeatable, &description, &sql).map_err(rep)
}

#[tauri::command]
async fn capture(path: String, env: String, description: String, as_baseline: bool) -> R<diff::Generated> {
    let cfg = load(&path)?;
    license::require("generate", None, Some(&cfg.root)).map_err(rep)?;
    diff::capture(&cfg, Some(&env), &description, as_baseline).await.map_err(rep)
}

/// Writes the HTML report of a check to a file the user picked.
#[tauri::command]
fn report_save(path: String, report: checks::CheckReport, file: String) -> R<()> {
    let cfg = load(&path)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    std::fs::write(&file, checks::report_html(&report, &cfg.project.name, &format!("unix time {now}"))).map_err(|e| rep(e.into()))
}

#[tauri::command]
async fn scratch_create(path: String) -> R<ProjectView> {
    let cfg = load(&path)?;
    diff::create_scratch(&cfg, None, "scratch").await.map_err(rep)?;
    Ok(view(&load(&path)?))
}

/* ---------- S14: git ---------- */

#[tauri::command]
fn git_status(path: String) -> R<liftoff_core::git::Status> {
    liftoff_core::git::status(Path::new(&path)).map_err(rep)
}

#[tauri::command]
fn git_diff(path: String, file: String) -> R<String> {
    liftoff_core::git::diff(Path::new(&path), &file).map_err(rep)
}

#[tauri::command]
async fn git_commit(path: String, files: Vec<String>, message: String) -> R<String> {
    liftoff_core::git::commit(Path::new(&path), &files, &message).map_err(rep)
}

#[tauri::command]
async fn git_push(path: String) -> R<()> {
    liftoff_core::git::push(Path::new(&path)).map_err(rep)
}

#[tauri::command]
async fn git_pull(path: String) -> R<()> {
    liftoff_core::git::pull(Path::new(&path)).map_err(rep)
}

/* ---------- S05 schema model, S15/S16 settings, S17 CI ---------- */

#[tauri::command]
async fn model_status(path: String) -> R<Vec<liftoff_core::model::ModelChange>> {
    let cfg = load(&path)?;
    license::require("model", None, Some(&cfg.root)).map_err(rep)?;
    liftoff_core::model::status(&cfg, None).await.map_err(rep)
}

#[tauri::command]
fn model_save(path: String, changes: Vec<liftoff_core::model::ModelChange>) -> R<usize> {
    let cfg = load(&path)?;
    license::require("model", None, Some(&cfg.root)).map_err(rep)?;
    liftoff_core::model::save(&cfg, &changes).map_err(rep)
}

#[tauri::command]
fn project_save(path: String, project: config::Project) -> R<ProjectView> {
    config::save_project(Path::new(&path), &project).map_err(rep)?;
    Ok(view(&load(&path)?))
}

#[tauri::command]
fn ci_workflow(path: String, options: liftoff_core::ci::CiOptions) -> R<String> {
    liftoff_core::ci::github_actions(&load(&path)?, &options).map_err(rep)
}

#[tauri::command]
fn ci_write(path: String, yaml: String, overwrite: bool) -> R<PathBuf> {
    liftoff_core::ci::write(&load(&path)?, &yaml, overwrite).map_err(rep)
}

/* ---------- licence ---------- */

#[tauri::command]
fn license_activate(text: String) -> R<license::Status> {
    let (lic, grace) = license::verify(&text, license::today()).map_err(rep)?;
    let file = license::default_file().ok_or_else(|| ErrorReport { code: "LIFTOFF_LICENSE", exit_code: 20, message: "no config folder to store the licence in".into() })?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| rep(e.into()))?;
    std::fs::write(&file, text.trim()).map_err(|e| rep(e.into()))?;
    Ok(license::Status { license: lic, grace_days_left: grace, source: file.display().to_string() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            recent_projects,
            recent_forget,
            project_init,
            project_open,
            project_convert_flyway,
            history_import,
            env_save,
            env_test,
            env_test_draft,
            migrations_info,
            migrate,
            validate,
            baseline,
            repair,
            clean,
            mark_applied,
            undo,
            check,
            scripts_list,
            script_add,
            capture,
            scratch_create,
            report_save,
            git_status,
            model_status,
            model_save,
            project_save,
            ci_workflow,
            ci_write,
            git_diff,
            git_commit,
            git_push,
            git_pull,
            changes_diff,
            migration_generate,
            migration_save,
            license_activate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiftOff");
}

#[cfg(test)]
mod tests {
    #[test]
    fn redacts_passwords() {
        assert_eq!(super::redact("postgres://me:s3cret@db:5432/x"), "postgres://me@db:5432/x");
        assert_eq!(super::redact("postgres://db/x"), "postgres://db/x");
        assert_eq!(super::redact("host=db dbname=x"), "host=db dbname=x");
    }
}
