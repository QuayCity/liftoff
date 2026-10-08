//! liftoff.toml (shared, in git) + liftoff.user.toml (per user, git-ignored) + env vars.
//! Precedence, lowest to highest: project file, user file, LIFTOFF_ENV_<NAME>_* variables.

use crate::error::{config, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PROJECT_FILE: &str = "liftoff.toml";
pub const USER_FILE: &str = "liftoff.user.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    #[serde(default = "d_engine")]
    pub engine: String,
    #[serde(default = "d_migrations")]
    pub migrations: String,
    #[serde(default = "d_schemas")]
    pub schemas: Vec<String>,
    #[serde(default = "d_table")]
    pub history_table: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Dev,
    Scratch,
    Test,
    Prod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Environment {
    /// libpq style: `postgres://host:5432/db` or `host=… dbname=…`
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default = "d_role")]
    pub role: Role,
    /// `clean` and scratch rebuilds are refused unless this is true (scratch envs imply it).
    #[serde(default)]
    pub allow_clean: bool,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub root: PathBuf,
    pub project: Project,
    pub environments: BTreeMap<String, Environment>,
}

#[derive(Deserialize)]
struct File {
    project: Project,
    #[serde(default)]
    environments: BTreeMap<String, Environment>,
}

fn d_engine() -> String { "postgresql".into() }
fn d_migrations() -> String { "migrations".into() }
fn d_schemas() -> Vec<String> { vec!["public".into()] }
fn d_table() -> String { "liftoff_schema_history".into() }
fn d_role() -> Role { Role::Dev }

impl Config {
    pub fn load(root: &Path) -> Result<Config> {
        let project_path = root.join(PROJECT_FILE);
        if !project_path.exists() {
            return config(format!("no {PROJECT_FILE} in {}; run `liftoff init` first", root.display()));
        }
        let mut table = read_table(&project_path)?;
        let user_path = root.join(USER_FILE);
        if user_path.exists() {
            merge(&mut table, read_table(&user_path)?);
        }
        let file: File = toml::Value::Table(table)
            .try_into()
            .or_else(|e| config(format!("{PROJECT_FILE}: {e}")))?;
        let mut environments = file.environments;
        for (name, env) in environments.iter_mut() {
            apply_env_vars(name, env, |k| std::env::var(k).ok());
            // Unset variables stay as `${env.X}` here and fail when this environment connects,
            // so one missing variable does not stop the whole project from loading.
            for v in [Some(&mut env.url), env.user.as_mut(), env.password.as_mut()].into_iter().flatten() {
                *v = interpolate(v, |k| std::env::var(k).ok()).unwrap_or_else(|_| v.clone());
            }
            if env.password.is_none() {
                env.password = keyring_get(root, name);
            }
        }
        Ok(Config { root: root.to_path_buf(), project: file.project, environments })
    }

    /// A project without liftoff.toml, for one-off CLI runs with `-url` (Flyway style).
    pub fn adhoc(root: &Path, migrations: &str) -> Config {
        Config {
            root: root.to_path_buf(),
            project: Project { name: "adhoc".into(), engine: d_engine(), migrations: migrations.into(), schemas: d_schemas(), history_table: d_table() },
            environments: BTreeMap::new(),
        }
    }

    pub fn env(&self, name: &str) -> Result<&Environment> {
        match self.environments.get(name) {
            Some(e) => Ok(e),
            None => config(format!("no environment '{name}'; configured: {}", self.env_names())),
        }
    }

    /// The named environment, or the only one when there is exactly one.
    pub fn pick(&self, name: Option<&str>) -> Result<(String, &Environment)> {
        match name {
            Some(n) => Ok((n.to_string(), self.env(n)?)),
            None if self.environments.len() == 1 => {
                let (n, e) = self.environments.iter().next().unwrap();
                Ok((n.clone(), e))
            }
            None => config(format!("pick an environment with --environment; configured: {}", self.env_names())),
        }
    }

    /// First environment with the role, unless one is named.
    pub fn pick_role(&self, name: Option<&str>, role: Role) -> Result<(String, &Environment)> {
        if let Some(n) = name {
            return Ok((n.to_string(), self.env(n)?));
        }
        match self.environments.iter().find(|(_, e)| e.role == role) {
            Some((n, e)) => Ok((n.clone(), e)),
            None => config(format!("no environment with role '{}'; add one or name it explicitly", role_name(role))),
        }
    }

    pub fn migrations_dir(&self) -> PathBuf {
        self.root.join(&self.project.migrations)
    }

    pub fn history_schema(&self) -> &str {
        &self.project.schemas[0]
    }

    fn env_names(&self) -> String {
        if self.environments.is_empty() {
            return "(none)".into();
        }
        self.environments.keys().cloned().collect::<Vec<_>>().join(", ")
    }
}

pub fn role_name(r: Role) -> &'static str {
    match r { Role::Dev => "dev", Role::Scratch => "scratch", Role::Test => "test", Role::Prod => "prod" }
}

/// Creates liftoff.toml, migrations/, schema-model/ and git-ignores the user file.
pub fn init(root: &Path, name: &str, engine: &str) -> Result<()> {
    if engine != "postgresql" {
        return config(format!("engine '{engine}' is not supported yet; use postgresql"));
    }
    init_with(root, name, "migrations", &["public".to_string()])
}

/// `init` with a given migrations folder and schemas (used when converting a Flyway project).
pub fn init_with(root: &Path, name: &str, migrations: &str, schemas: &[String]) -> Result<()> {
    let path = root.join(PROJECT_FILE);
    if path.exists() {
        return config(format!("{} already exists", path.display()));
    }
    std::fs::create_dir_all(root.join(migrations))?;
    std::fs::create_dir_all(root.join("schema-model"))?;
    let mut project = toml::Table::new();
    project.insert("name".into(), name.into());
    project.insert("engine".into(), "postgresql".into());
    project.insert("migrations".into(), migrations.into());
    project.insert("schemas".into(), toml::Value::Array(schemas.iter().map(|s| s.as_str().into()).collect()));
    project.insert("history_table".into(), "liftoff_schema_history".into());
    let mut file = toml::Table::new();
    file.insert("project".into(), project.into());
    std::fs::write(&path, toml::to_string_pretty(&file).or_else(|e| config(e.to_string()))?)?;
    let gitignore = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if !existing.lines().any(|l| l.trim() == USER_FILE) {
        let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&gitignore, format!("{existing}{sep}{USER_FILE}\n"))?;
    }
    Ok(())
}

const KEYRING_SERVICE: &str = "liftoff";

fn keyring_enabled() -> bool {
    std::env::var_os("LIFTOFF_NO_KEYRING").is_none()
}

/// One keychain entry per project folder + environment.
fn keyring_account(root: &Path, env: &str) -> String {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    format!("{}#{env}", root.display())
}

fn keyring_get(root: &Path, env: &str) -> Option<String> {
    if !keyring_enabled() {
        return None;
    }
    keyring::Entry::new(KEYRING_SERVICE, &keyring_account(root, env)).ok()?.get_password().ok()
}

fn keyring_set(root: &Path, env: &str, password: &str) -> bool {
    keyring_enabled()
        && keyring::Entry::new(KEYRING_SERVICE, &keyring_account(root, env)).is_ok_and(|e| e.set_password(password).is_ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PasswordStore {
    None,
    /// OS keychain: Windows Credential Manager, macOS Keychain or Secret Service
    Keychain,
    /// fallback when no keychain is available: plain text in the git-ignored user file
    UserFile,
}

/// Writes one environment into the project file (shared) or the user file (private).
/// A password goes to the OS keychain when there is one, else to the git-ignored user file;
/// it never goes to the shared project file.
pub fn save_environment(root: &Path, name: &str, env: &Environment, shared: bool) -> Result<PasswordStore> {
    save_environment_with(root, name, env, shared, keyring_enabled())
}

pub(crate) fn save_environment_with(root: &Path, name: &str, env: &Environment, shared: bool, use_keychain: bool) -> Result<PasswordStore> {
    let mut env = env.clone();
    let mut store = PasswordStore::None;
    if let Some(pw) = env.password.clone() {
        if use_keychain && keyring_set(root, name, &pw) {
            env.password = None;
            store = PasswordStore::Keychain;
            remove_user_password(root, name)?;
        } else {
            store = PasswordStore::UserFile;
        }
    }
    let env = &env;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return config("environment names use letters, digits, - and _ only");
    }
    let path = root.join(if shared { PROJECT_FILE } else { USER_FILE });
    let mut table = if path.exists() { read_table(&path)? } else { toml::Table::new() };
    let mut value = toml::Value::try_from(env).or_else(|e| config(e.to_string()))?;
    if shared {
        // Secrets never go to the shared file.
        value.as_table_mut().unwrap().remove("password");
    }
    table
        .entry("environments")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| crate::Error::Config("`environments` must be a table".into()))?
        .insert(name.into(), value);
    std::fs::write(&path, toml::to_string_pretty(&table).or_else(|e| config(e.to_string()))?)?;
    if shared && env.password.is_some() {
        let user_path = root.join(USER_FILE);
        let mut user = if user_path.exists() { read_table(&user_path)? } else { toml::Table::new() };
        let mut secret = toml::Table::new();
        secret.insert("password".into(), env.password.clone().unwrap().into());
        let mut envs = toml::Table::new();
        envs.insert(name.into(), secret.into());
        let mut patch = toml::Table::new();
        patch.insert("environments".into(), envs.into());
        merge(&mut user, patch);
        std::fs::write(&user_path, toml::to_string_pretty(&user).or_else(|e| config(e.to_string()))?)?;
    }
    Ok(store)
}

/// Drops a plain-text password left in the user file once the keychain holds it.
fn remove_user_password(root: &Path, name: &str) -> Result<()> {
    let path = root.join(USER_FILE);
    if !path.exists() {
        return Ok(());
    }
    let mut table = read_table(&path)?;
    let removed = table
        .get_mut("environments")
        .and_then(|e| e.as_table_mut())
        .and_then(|e| e.get_mut(name))
        .and_then(|e| e.as_table_mut())
        .is_some_and(|e| e.remove("password").is_some());
    if removed {
        std::fs::write(&path, toml::to_string_pretty(&table).or_else(|e| config(e.to_string()))?)?;
    }
    Ok(())
}

fn read_table(path: &Path) -> Result<toml::Table> {
    let text = std::fs::read_to_string(path)?;
    text.parse::<toml::Table>().or_else(|e| config(format!("{}: {e}", path.display())))
}

fn merge(base: &mut toml::Table, over: toml::Table) {
    for (k, v) in over {
        match (base.get_mut(&k), v) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => merge(b, o),
            (_, v) => {
                base.insert(k, v);
            }
        }
    }
}

fn apply_env_vars(name: &str, env: &mut Environment, get: impl Fn(&str) -> Option<String>) {
    let prefix = format!("LIFTOFF_ENV_{}_", name.to_uppercase().replace('-', "_"));
    if let Some(v) = get(&format!("{prefix}URL")) { env.url = v; }
    if let Some(v) = get(&format!("{prefix}USER")) { env.user = Some(v); }
    if let Some(v) = get(&format!("{prefix}PASSWORD")) { env.password = Some(v); }
}

/// `${env.NAME}` placeholders resolve from environment variables; a missing one is an error.
fn interpolate(s: &str, get: impl Fn(&str) -> Option<String>) -> Result<String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("${env.") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 6..];
        let Some(end) = after.find('}') else { return config(format!("unclosed ${{env.…}} in '{s}'")) };
        let key = &after[..end];
        match get(key) {
            Some(v) => out.push_str(&v),
            None => return config(format!("environment variable {key} is not set")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_and_overrides() {
        let get = |k: &str| (k == "PW").then(|| "s3cret".to_string());
        assert_eq!(interpolate("a${env.PW}b", get).unwrap(), "as3cretb");
        assert!(interpolate("${env.MISSING}", |_| None).is_err());

        let mut env = Environment { url: "x".into(), user: None, password: None, role: Role::Dev, allow_clean: false };
        apply_env_vars("my-db", &mut env, |k| (k == "LIFTOFF_ENV_MY_DB_URL").then(|| "y".to_string()));
        assert_eq!(env.url, "y");
    }

    #[test]
    #[ignore = "writes to the real OS keychain; run with --include-ignored"]
    fn keychain_round_trip() {
        let dir = std::env::temp_dir().join(format!("liftoff-kc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        init(&dir, "kc", "postgresql").unwrap();
        let env = Environment { url: "postgres://h/db".into(), user: None, password: Some("kc-secret".into()), role: Role::Dev, allow_clean: false };
        assert_eq!(save_environment_with(&dir, "dev", &env, false, true).unwrap(), PasswordStore::Keychain);
        let user = std::fs::read_to_string(dir.join(USER_FILE)).unwrap();
        assert!(!user.contains("kc-secret"), "password must not touch disk: {user}");
        assert_eq!(Config::load(&dir).unwrap().env("dev").unwrap().password.as_deref(), Some("kc-secret"));
        keyring::Entry::new(KEYRING_SERVICE, &keyring_account(&dir, "dev")).unwrap().delete_credential().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn init_load_and_user_overrides() {
        let dir = std::env::temp_dir().join(format!("liftoff-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        init(&dir, "shop", "postgresql").unwrap();
        assert!(init(&dir, "shop", "postgresql").is_err(), "second init must refuse");
        let env = Environment { url: "postgres://h/db".into(), user: Some("u".into()), password: Some("pw".into()), role: Role::Test, allow_clean: false };
        assert_eq!(save_environment_with(&dir, "staging", &env, true, false).unwrap(), PasswordStore::UserFile);
        let shared = std::fs::read_to_string(dir.join(PROJECT_FILE)).unwrap();
        assert!(!shared.contains("pw"), "password leaked into the shared file");
        let cfg = Config::load(&dir).unwrap();
        assert_eq!(cfg.env("staging").unwrap().password.as_deref(), Some("pw"));
        assert_eq!(cfg.pick(None).unwrap().0, "staging");
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains(USER_FILE));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
