//! Switching from Flyway (F12): convert flyway.toml / flyway.conf into liftoff.toml, and import a
//! database's flyway_schema_history once into LiftOff's own history table.
//! Built from Flyway's publicly documented config keys and history columns only.

use crate::config::{self, Environment, Role};
use crate::db::{self, quote_ident as q};
use crate::error::{config as cfg_err, Error, Result};
use crate::migration::{self, Kind, Version};
use crate::runner::{Level, Log};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_TABLE: &str = "flyway_schema_history";

/// Which Flyway config files a folder has.
pub fn detect(root: &Path) -> Vec<PathBuf> {
    ["flyway.toml", "flyway.conf", "conf/flyway.toml", "conf/flyway.conf"].iter().map(|f| root.join(f)).filter(|p| p.exists()).collect()
}

#[derive(Debug, Default, Serialize)]
pub struct ConvertReport {
    pub source: String,
    pub written: PathBuf,
    pub environments: Vec<String>,
    pub migrations: String,
    pub schemas: Vec<String>,
    /// Flyway's history table name, for the history import
    pub flyway_table: String,
    /// settings LiftOff did not carry over, each with the reason
    pub not_converted: Vec<String>,
    pub notes: Vec<String>,
}

/// Everything we read from either format, before writing liftoff.toml.
#[derive(Debug, Default)]
struct Parsed {
    envs: Vec<(String, BTreeMap<String, String>)>,
    /// flyway.* settings, flattened: "locations", "schemas", "table", "placeholders.x" ...
    settings: BTreeMap<String, String>,
}

/// flyway.conf: Java properties with `flyway.` keys.
fn parse_conf(text: &str) -> Parsed {
    let mut settings = BTreeMap::new();
    let mut pending = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if pending.is_empty() && (line.is_empty() || line.starts_with('#') || line.starts_with('!')) {
            continue;
        }
        // A trailing backslash continues the value on the next line.
        if let Some(cont) = line.strip_suffix('\\') {
            pending.push_str(cont);
            continue;
        }
        pending.push_str(line);
        let entry = std::mem::take(&mut pending);
        if let Some((k, v)) = entry.split_once(['=', ':']) {
            let k = k.trim();
            settings.insert(k.strip_prefix("flyway.").unwrap_or(k).to_string(), v.trim().to_string());
        }
    }
    let mut env = BTreeMap::new();
    for k in ["url", "user", "password", "schemas"] {
        if let Some(v) = settings.remove(k) {
            env.insert(k.to_string(), v);
        }
    }
    Parsed { envs: if env.is_empty() { vec![] } else { vec![("default".into(), env)] }, settings }
}

/// flyway.toml: `[environments.<name>]` plus `[flyway]` settings.
fn parse_toml(text: &str) -> Result<Parsed> {
    let t: toml::Table = text.parse().or_else(|e| cfg_err(format!("flyway.toml: {e}")))?;
    let as_text = |v: &toml::Value| match v {
        toml::Value::String(s) => s.clone(),
        toml::Value::Array(a) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    };
    let mut p = Parsed::default();
    if let Some(envs) = t.get("environments").and_then(|e| e.as_table()) {
        for (name, e) in envs {
            let fields = e.as_table().map(|e| e.iter().map(|(k, v)| (k.clone(), as_text(v))).collect()).unwrap_or_default();
            p.envs.push((name.clone(), fields));
        }
    }
    fn flatten(prefix: &str, t: &toml::Table, out: &mut BTreeMap<String, String>, as_text: &dyn Fn(&toml::Value) -> String) {
        for (k, v) in t {
            let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            match v {
                toml::Value::Table(inner) => flatten(&key, inner, out, as_text),
                v => {
                    out.insert(key, as_text(v));
                }
            }
        }
    }
    // [flyway] keys stay bare ("locations"); other sections keep their name ("flywayDesktop.shadowEnvironment").
    for (section, v) in t.iter().filter(|(k, _)| *k != "environments") {
        match (section.as_str(), v) {
            ("flyway", toml::Value::Table(f)) => flatten("", f, &mut p.settings, &as_text),
            (_, toml::Value::Table(f)) => flatten(section, f, &mut p.settings, &as_text),
            (_, v) => {
                p.settings.insert(section.clone(), as_text(v));
            }
        }
    }
    Ok(p)
}

/// `jdbc:postgresql://host:5432/db?x=y` -> `postgres://host:5432/db?x=y`
pub fn jdbc_to_url(jdbc: &str) -> Option<String> {
    let rest = jdbc.trim().strip_prefix("jdbc:postgresql:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    Some(format!("postgres://{rest}"))
}

fn role_for(name: &str, desktop: &BTreeMap<String, String>) -> Role {
    let lower = name.to_lowercase();
    if desktop.get("developmentEnvironment").is_some_and(|d| d == name) || lower.starts_with("dev") {
        Role::Dev
    } else if desktop.get("shadowEnvironment").is_some_and(|s| s == name) || lower.contains("shadow") || lower.contains("scratch") {
        Role::Scratch
    } else if lower.contains("prod") {
        Role::Prod
    } else {
        Role::Test
    }
}

/// Writes liftoff.toml (and credentials to the keychain / user file) from the folder's Flyway config.
/// The Flyway files are left untouched. Refuses when liftoff.toml already exists.
pub fn convert(root: &Path, name: &str) -> Result<ConvertReport> {
    convert_with(root, name, true)
}

fn convert_with(root: &Path, name: &str, use_keychain: bool) -> Result<ConvertReport> {
    let found = detect(root);
    let Some(source) = found.iter().find(|p| p.extension().is_some_and(|e| e == "toml")).or(found.first()) else {
        return cfg_err(format!("no flyway.toml or flyway.conf in {}", root.display()));
    };
    if root.join(config::PROJECT_FILE).exists() {
        return cfg_err(format!("{} already exists; remove it to convert again", config::PROJECT_FILE));
    }
    let text = std::fs::read_to_string(source)?;
    let mut p = if source.extension().is_some_and(|e| e == "toml") { parse_toml(&text)? } else { parse_conf(&text) };
    let mut r = ConvertReport { source: source.display().to_string(), ..Default::default() };
    for other in found.iter().filter(|f| *f != source) {
        r.notes.push(format!("{} was also found and was not merged; {} was used", other.display(), source.display()));
    }

    let desktop: BTreeMap<String, String> = p.settings.iter().filter_map(|(k, v)| k.strip_prefix("flywayDesktop.").map(|k| (k.to_string(), v.clone()))).collect();

    // Migrations folder: the first filesystem location.
    let locations: Vec<String> = p.settings.remove("locations").map(|l| l.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let mut folder = None;
    for l in &locations {
        match l.strip_prefix("filesystem:") {
            Some(f) if folder.is_none() => folder = Some(f.trim_start_matches("./").to_string()),
            Some(f) => r.not_converted.push(format!("locations {l}: LiftOff reads one migrations folder ({}); move {f} into it", folder.as_deref().unwrap_or(""))),
            None => r.not_converted.push(format!("locations {l}: only filesystem: locations are supported (classpath and cloud locations are not)")),
        }
    }
    r.migrations = folder.unwrap_or_else(|| {
        r.notes.push("no filesystem location set; using Flyway's default folder `sql`".into());
        "sql".into()
    });

    r.flyway_table = p.settings.remove("table").unwrap_or_else(|| DEFAULT_TABLE.into());
    let default_schema = p.settings.remove("defaultSchema");
    let mut schemas: Vec<String> = p.settings.remove("schemas").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    // Environment-level schemas apply when the global setting is absent.
    if schemas.is_empty() && let Some((_, e)) = p.envs.iter().find(|(_, e)| e.contains_key("schemas")) {
        schemas = e["schemas"].split(',').map(|x| x.trim().to_string()).collect();
    }
    if let Some(d) = default_schema {
        schemas.retain(|s| *s != d);
        schemas.insert(0, d);
    }
    if schemas.is_empty() {
        schemas.push("public".into());
    }
    r.schemas = schemas.clone();
    let clean_allowed = p.settings.remove("cleanDisabled").is_some_and(|v| v.eq_ignore_ascii_case("false"));
    p.settings.remove("environment");

    // Settings we understand but do not need, and ones we cannot carry over.
    for (k, v) in &p.settings {
        let reason = match k.as_str() {
            // Desktop-app and comparison settings, and project ids: nothing to carry over.
            k if k.starts_with("flywayDesktop.") || k.starts_with("redgateCompare.") => continue,
            "id" | "name" | "databaseType" => continue,
            k if k.starts_with("placeholders.") || k.starts_with("placeholder") => "placeholders are not supported; replace them in the scripts",
            k if k.starts_with("callbacks") => "callbacks are not supported; turn them into scripts",
            k if k.starts_with("javaMigrations") || k.starts_with("resolvers") => "Java migrations and resolvers need a JVM; they are not supported",
            "sqlMigrationPrefix" | "repeatableSqlMigrationPrefix" | "undoSqlMigrationPrefix" | "sqlMigrationSeparator" | "sqlMigrationSuffixes" => {
                "LiftOff uses the standard V/R/U/B prefixes, `__` and `.sql`; rename the files"
            }
            "outOfOrder" | "target" | "validateOnMigrate" | "ignoreMigrationPatterns" | "mixed" | "group" => "a per-run option in LiftOff; pass it on the command line",
            "baselineOnMigrate" | "baselineVersion" | "baselineDescription" => "use `liftoff baseline` once per database instead",
            _ => "not used by LiftOff",
        };
        r.not_converted.push(format!("{k} = {v}: {reason}"));
    }

    config::init_with(root, name, &r.migrations, &schemas)?;
    if r.flyway_table != DEFAULT_TABLE {
        r.notes.push(format!("Flyway's history table is {}; pass it to the history import", r.flyway_table));
    }

    for (env_name, fields) in &p.envs {
        let Some(jdbc) = fields.get("url") else {
            r.not_converted.push(format!("environment {env_name}: no url"));
            continue;
        };
        let Some(url) = jdbc_to_url(&interpolate_flyway(jdbc)) else {
            r.not_converted.push(format!("environment {env_name}: {jdbc} is not PostgreSQL; LiftOff supports PostgreSQL for now"));
            continue;
        };
        let role = role_for(env_name, &desktop);
        let env = Environment {
            url,
            user: fields.get("user").map(|u| interpolate_flyway(u)),
            password: fields.get("password").map(|p| interpolate_flyway(p)),
            role,
            allow_clean: clean_allowed && role != Role::Prod,
        };
        let name = if env_name == "default" { "default".to_string() } else { env_name.replace(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'), "_") };
        config::save_environment_with(root, &name, &env, true, use_keychain && std::env::var_os("LIFTOFF_NO_KEYRING").is_none())?;
        for k in fields.keys().filter(|k| !["url", "user", "password", "schemas"].contains(&k.as_str())) {
            r.not_converted.push(format!("environments.{env_name}.{k}: not used by LiftOff"));
        }
        r.environments.push(name);
    }
    r.written = root.join(config::PROJECT_FILE);
    Ok(r)
}

/// Flyway writes environment variables as `${env.NAME}` (toml) or `${NAME}` (conf); LiftOff uses `${env.NAME}`.
fn interpolate_flyway(v: &str) -> String {
    let mut out = String::new();
    let mut rest = v;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                out.push_str(&format!("${{env.{}}}", key.strip_prefix("env.").unwrap_or(key)));
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/* ---------- one-time history import ---------- */

#[derive(Debug, Default, Serialize)]
pub struct HistoryImport {
    pub environment: String,
    pub imported: usize,
    /// Flyway rows LiftOff has no use for (schema-creation markers)
    pub skipped: Vec<String>,
    /// applied scripts whose files changed since they ran (import refuses unless accepted)
    pub edited: Vec<String>,
    /// rows that need a decision afterwards (e.g. Java migrations without a .sql file)
    pub attention: Vec<String>,
}

/// Copies `<schema>.<from_table>` into LiftOff's history table on one environment. Refuses when
/// LiftOff already has history there, or when applied scripts were edited (unless `accept_edited`,
/// which stores the current files' checksums). Flyway's table is left untouched.
pub async fn import_history(cfg: &config::Config, env_name: Option<&str>, from_table: &str, accept_edited: bool, log: Log<'_>) -> Result<HistoryImport> {
    let (name, env) = cfg.pick(env_name)?;
    let (schema, table) = (cfg.history_schema().to_string(), cfg.project.history_table.clone());
    if from_table == table {
        return cfg_err("the Flyway table and LiftOff's history table must have different names");
    }
    let c = db::connect(&name, env).await?;
    db::lock(&c, &schema, &table, || log(Level::Info, "Another run holds the lock on this database; waiting")).await?;
    let result = async {
        if !db::history_exists(&c, &schema, from_table).await? {
            return cfg_err(format!("{name} has no {schema}.{from_table}"));
        }
        db::ensure_history(&c, &schema, &table).await?;
        if !db::read_history(&c, &schema, &table).await?.is_empty() {
            return Err(Error::Validate(format!("{name} already has LiftOff history; the import only runs once")));
        }
        let rows = db::read_history(&c, &schema, from_table).await?;
        let scripts = migration::scan(&cfg.migrations_dir())?;
        let mut report = HistoryImport { environment: name.clone(), ..Default::default() };

        let mut out = Vec::new();
        for r in rows {
            let mut r = r;
            match r.kind.as_str() {
                "SCHEMA" => {
                    report.skipped.push(format!("rank {}: {} (schema creation marker)", r.installed_rank, r.script));
                    continue;
                }
                // A baseline migration (B script) puts the database at its version.
                "SQL_BASELINE" => r.kind = "BASELINE".into(),
                "JDBC" | "SPRING_JDBC" | "SCRIPT" | "CUSTOM" | "UNDO_JDBC" | "UNDO_SCRIPT" => report.attention.push(format!(
                    "{} ({}): not a .sql script; if it is retired, `liftoff repair` marks it as forgotten",
                    r.script, r.kind
                )),
                _ => {}
            }
            if r.success && (r.kind == "SQL" || r.kind == "UNDO_SQL") {
                let file = scripts.iter().find(|s| {
                    s.file_name == r.script.rsplit(['/', '\\']).next().unwrap_or(&r.script)
                        && (s.kind == Kind::Repeatable || s.version == r.version.as_deref().and_then(Version::parse))
                });
                if let Some(f) = file
                    && r.checksum != Some(f.checksum)
                {
                    report.edited.push(format!("{}: ran with checksum {}, the file now has {}", f.file_name, r.checksum.unwrap_or(0), f.checksum));
                    if accept_edited {
                        r.checksum = Some(f.checksum);
                    }
                }
                // Flyway stores the path relative to the location; LiftOff stores the file name.
                if let Some(f) = file {
                    r.script = f.file_name.clone();
                }
            }
            out.push(r);
        }
        if !report.edited.is_empty() && !accept_edited {
            return Err(Error::Validate(format!(
                "scripts changed after they ran on {name}:\n{}\nRestore them, or import with --accept-edited to keep the current files",
                report.edited.join("\n")
            )));
        }
        let t = format!("{}.{}", q(&schema), q(&table));
        c.batch_execute("BEGIN").await?;
        let copy = async {
            for r in &out {
                c.execute(
                    &format!(
                        "insert into {t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
                         values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')::timestamp, $9, $10)"
                    ),
                    &[&r.installed_rank, &r.version, &r.description, &r.kind, &r.script, &r.checksum, &r.installed_by, &r.installed_on, &r.execution_time, &r.success],
                )
                .await?;
            }
            Ok::<_, Error>(())
        }
        .await;
        match copy {
            Ok(()) => c.batch_execute("COMMIT").await?,
            Err(e) => {
                let _ = c.batch_execute("ROLLBACK").await;
                return Err(e);
            }
        }
        report.imported = out.len();
        log(Level::Info, &format!("Imported {} history row(s) from {schema}.{from_table} into {schema}.{table} on {name}; Flyway's table was left as it was", out.len()));
        Ok(report)
    }
    .await;
    let _ = db::unlock(&c, &schema, &table).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jdbc_urls() {
        assert_eq!(jdbc_to_url("jdbc:postgresql://db:5432/shop?ssl=true").as_deref(), Some("postgres://db:5432/shop?ssl=true"));
        assert_eq!(jdbc_to_url("jdbc:sqlserver://db;databaseName=x"), None);
    }

    #[test]
    fn env_placeholders() {
        assert_eq!(interpolate_flyway("${env.DB_PW}"), "${env.DB_PW}");
        assert_eq!(interpolate_flyway("pre-${DB_USER}-x"), "pre-${env.DB_USER}-x");
    }

    #[test]
    fn converts_conf_and_toml() {
        let dir = std::env::temp_dir().join(format!("liftoff-fw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("flyway.conf"),
            "# legacy\nflyway.url=jdbc:postgresql://localhost:5432/shop\nflyway.user=app\nflyway.password=${DB_PW}\n\
             flyway.schemas=sales,public\nflyway.locations=filesystem:db/migration,classpath:db/extra\n\
             flyway.placeholders.owner=app\nflyway.table=schema_version\nflyway.cleanDisabled=false\n",
        )
        .unwrap();
        let r = convert_with(&dir, "shop", false).unwrap();
        assert_eq!((r.migrations.as_str(), r.schemas.clone(), r.flyway_table.as_str()), ("db/migration", vec!["sales".to_string(), "public".to_string()], "schema_version"));
        assert_eq!(r.environments, ["default"]);
        assert!(r.not_converted.iter().any(|n| n.starts_with("placeholders.owner")), "{:#?}", r.not_converted);
        assert!(r.not_converted.iter().any(|n| n.contains("classpath:db/extra")), "{:#?}", r.not_converted);
        let shared = std::fs::read_to_string(dir.join(config::PROJECT_FILE)).unwrap();
        assert!(shared.contains("postgres://localhost:5432/shop") && !shared.contains("DB_PW"), "{shared}");
        let user = std::fs::read_to_string(dir.join(config::USER_FILE)).unwrap();
        assert!(user.contains("${env.DB_PW}"), "password placeholder goes to the private file: {user}");
        assert!(convert_with(&dir, "shop", false).is_err(), "never overwrites liftoff.toml");

        std::fs::remove_file(dir.join(config::PROJECT_FILE)).unwrap();
        std::fs::remove_file(dir.join(config::USER_FILE)).unwrap();
        std::fs::write(
            dir.join("flyway.toml"),
            "[environments.development]\nurl = \"jdbc:postgresql://localhost/shop_dev\"\n\
             [environments.shadow]\nurl = \"jdbc:postgresql://localhost/shop_shadow\"\n\
             [environments.production]\nurl = \"jdbc:postgresql://prod/shop\"\nuser = \"deploy\"\n\
             [flyway]\nlocations = [\"filesystem:migrations\"]\nschemas = [\"public\"]\n\
             [flywayDesktop]\ndevelopmentEnvironment = \"development\"\nshadowEnvironment = \"shadow\"\n",
        )
        .unwrap();
        let r = convert_with(&dir, "shop", false).unwrap();
        assert!(r.notes.iter().any(|n| n.contains("flyway.conf was also found")), "{:#?}", r.notes);
        let cfg = config::Config::load(&dir).unwrap();
        assert_eq!(cfg.project.migrations, "migrations");
        assert_eq!(cfg.env("development").unwrap().role, Role::Dev);
        assert_eq!(cfg.env("shadow").unwrap().role, Role::Scratch);
        assert_eq!(cfg.env("production").unwrap().role, Role::Prod);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
