//! Schema diff (C11) and migration generation (C12).
//! Slice scope: tables and columns (type, nullability, default, identity, serial).
//! Constraints, indexes, views, functions etc. come in milestone 2 (architecture.md).

use crate::config::{role_name, Config, Role};
use crate::db::{self, quote_ident as q};
use crate::error::{config, Result};
use crate::migration;
use crate::runner::{self, Level, Log, MigrateOptions};
use serde::Serialize;
use std::collections::BTreeMap;
use tokio_postgres::Client;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub default: Option<String>,
    /// "always" | "by default"
    pub identity: Option<String>,
}

pub type Model = BTreeMap<(String, String), Vec<Column>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Changed,
    Removed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub id: String,
    pub object_type: String,
    pub name: String,
    pub kind: ChangeKind,
    pub destructive: bool,
    /// the DDL that turns the target into the source for this object
    pub sql: String,
}

pub async fn introspect(c: &Client, schemas: &[String], exclude_table: &str) -> Result<Model> {
    let rows = c
        .query(
            "select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod),
                    a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
             where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1) and c.relname <> $2
             order by 1, 2, a.attnum",
            &[&schemas, &exclude_table],
        )
        .await?;
    let mut model = Model::new();
    for r in rows {
        let cols = model.entry((r.get(0), r.get(1))).or_default();
        let Some(name) = r.get::<_, Option<String>>(2) else { continue };
        let identity = match r.get::<_, Option<String>>(6).as_deref() {
            Some("a") => Some("always".to_string()),
            Some("d") => Some("by default".to_string()),
            _ => None,
        };
        let mut col = Column { name, data_type: r.get(3), not_null: r.get(4), default: r.get(5), identity };
        normalize_serial(&mut col);
        cols.push(col);
    }
    Ok(model)
}

/// `integer DEFAULT nextval('t_id_seq'::regclass)` -> `serial`, so the owned sequence comes along.
/// ponytail: assumes the sequence is the column's own; shared sequences arrive with sequence support.
fn normalize_serial(c: &mut Column) {
    if c.default.as_deref().is_some_and(|d| d.starts_with("nextval(")) {
        let serial = match c.data_type.as_str() {
            "integer" => "serial",
            "bigint" => "bigserial",
            "smallint" => "smallserial",
            _ => return,
        };
        c.data_type = serial.into();
        c.default = None;
    }
}

fn col_def(c: &Column) -> String {
    let mut s = format!("{} {}", q(&c.name), c.data_type);
    if let Some(i) = &c.identity {
        s.push_str(&format!(" GENERATED {} AS IDENTITY", i.to_uppercase()));
    }
    if let Some(d) = &c.default {
        s.push_str(&format!(" DEFAULT {d}"));
    }
    if c.not_null && !c.data_type.ends_with("serial") && c.identity.is_none() {
        s.push_str(" NOT NULL");
    }
    s
}

/// Changes that turn `target` (what the migrations produce) into `source` (what dev looks like).
pub fn compare(source: &Model, target: &Model) -> Vec<Change> {
    let mut out = Vec::new();
    let table = |(s, t): &(String, String)| format!("{}.{}", q(s), q(t));
    for (key, cols) in source {
        let name = format!("{}.{}", key.0, key.1);
        match target.get(key) {
            None => {
                let body = cols.iter().map(|c| format!("    {}", col_def(c))).collect::<Vec<_>>().join(",\n");
                out.push(change(&name, ChangeKind::Added, false, format!("CREATE TABLE {} (\n{body}\n);", table(key))));
            }
            Some(old) => {
                let t = table(key);
                let mut stmts = Vec::new();
                let mut destructive = false;
                for c in cols {
                    match old.iter().find(|o| o.name == c.name) {
                        None => {
                            stmts.push(format!("ALTER TABLE {t} ADD COLUMN {};", col_def(c)));
                        }
                        Some(o) if o == c => {}
                        Some(o) => {
                            let col = q(&c.name);
                            if o.data_type != c.data_type || o.identity != c.identity {
                                // Type and identity changes rewrite data: treat as data-loss risk, review by hand.
                                destructive = true;
                                if o.identity.is_some() && c.identity.is_none() {
                                    stmts.push(format!("ALTER TABLE {t} ALTER COLUMN {col} DROP IDENTITY;"));
                                }
                                if o.data_type != c.data_type {
                                    stmts.push(format!("ALTER TABLE {t} ALTER COLUMN {col} TYPE {} USING {col}::{};", c.data_type, c.data_type));
                                }
                                if let (None, Some(i)) = (&o.identity, &c.identity) {
                                    stmts.push(format!("ALTER TABLE {t} ALTER COLUMN {col} ADD GENERATED {} AS IDENTITY;", i.to_uppercase()));
                                }
                            }
                            if o.default != c.default {
                                stmts.push(match &c.default {
                                    Some(d) => format!("ALTER TABLE {t} ALTER COLUMN {col} SET DEFAULT {d};"),
                                    None => format!("ALTER TABLE {t} ALTER COLUMN {col} DROP DEFAULT;"),
                                });
                            }
                            if o.not_null != c.not_null && c.identity.is_none() {
                                stmts.push(format!("ALTER TABLE {t} ALTER COLUMN {col} {} NOT NULL;", if c.not_null { "SET" } else { "DROP" }));
                            }
                        }
                    }
                }
                for o in old.iter().filter(|o| !cols.iter().any(|c| c.name == o.name)) {
                    destructive = true;
                    stmts.push(format!("ALTER TABLE {t} DROP COLUMN {};", q(&o.name)));
                }
                if !stmts.is_empty() {
                    out.push(change(&name, ChangeKind::Changed, destructive, stmts.join("\n")));
                }
            }
        }
    }
    for key in target.keys().filter(|k| !source.contains_key(*k)) {
        out.push(change(&format!("{}.{}", key.0, key.1), ChangeKind::Removed, true, format!("DROP TABLE {};", table(key))));
    }
    out
}

fn change(name: &str, kind: ChangeKind, destructive: bool, sql: String) -> Change {
    Change { id: format!("table:{name}"), object_type: "Tables".into(), name: name.into(), kind, destructive, sql }
}

/// Rebuilds the scratch database from the project's migrations, then diffs dev against it.
/// Refuses unless the scratch env has role `scratch` or `allow_clean = true`: it drops the managed schemas.
pub async fn dev_vs_migrations(cfg: &Config, dev: Option<&str>, scratch: Option<&str>, log: Log<'_>) -> Result<Vec<Change>> {
    let (dev_name, dev_env) = cfg.pick_role(dev, Role::Dev)?;
    let (scratch_name, scratch_env) = cfg.pick_role(scratch, Role::Scratch)?;
    if dev_name == scratch_name {
        return config("the dev and scratch environments must be different databases");
    }
    if scratch_env.role != Role::Scratch && !scratch_env.allow_clean {
        return config(format!(
            "'{scratch_name}' has role '{}' and allow_clean is off; refusing to rebuild it as a scratch database",
            role_name(scratch_env.role)
        ));
    }

    log(Level::Info, &format!("Rebuilding scratch database '{scratch_name}' from migrations"));
    let s = db::connect(&scratch_name, scratch_env).await?;
    for schema in &cfg.project.schemas {
        s.batch_execute(&format!("DROP SCHEMA IF EXISTS {0} CASCADE; CREATE SCHEMA {0};", q(schema))).await?;
    }
    runner::migrate(cfg, Some(&scratch_name), MigrateOptions { out_of_order: true }, log).await?;

    log(Level::Info, &format!("Comparing '{dev_name}' with the migrations"));
    let d = db::connect(&dev_name, dev_env).await?;
    let table = &cfg.project.history_table;
    let source = introspect(&d, &cfg.project.schemas, table).await?;
    let target = introspect(&s, &cfg.project.schemas, table).await?;
    let changes = compare(&source, &target);
    log(Level::Info, &format!("{} difference(s)", changes.len()));
    Ok(changes)
}

#[derive(Debug, Serialize)]
pub struct Generated {
    pub file_name: String,
    pub version: String,
    pub sql: String,
}

/// Renders the selected changes as the next versioned migration (not yet written to disk).
pub fn generate(cfg: &Config, changes: &[Change], description: &str) -> Result<Generated> {
    if changes.is_empty() {
        return config("nothing selected to put in the migration");
    }
    let desc = description.trim();
    if desc.is_empty() || !desc.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '_' || c == '-') {
        return config("describe the migration with letters, digits, spaces, - or _");
    }
    let existing = migration::scan(&cfg.migrations_dir())?;
    let version = migration::next_version(&existing, time::OffsetDateTime::now_utc());
    let order = |c: &&Change| match c.kind { ChangeKind::Added => 0, ChangeKind::Changed => 1, ChangeKind::Removed => 2 };
    let mut sorted: Vec<&Change> = changes.iter().collect();
    sorted.sort_by_key(order);
    let mut sql = format!("-- {desc}\n-- Written by LiftOff. Review before committing.\n");
    for c in sorted {
        sql.push_str(&format!("\n-- {} {}{}\n{}\n", kind_word(c.kind), c.name, if c.destructive { " (may lose data)" } else { "" }, c.sql));
    }
    let file_name = format!("V{version}__{}.sql", desc.replace([' ', '-'], "_"));
    Ok(Generated { file_name, version, sql })
}

/// Writes a generated script into the migrations folder; never overwrites.
pub fn save(cfg: &Config, file_name: &str, sql: &str) -> Result<std::path::PathBuf> {
    if migration::parse_name(file_name).is_none() || file_name.contains(['/', '\\']) {
        return config(format!("'{file_name}' is not a valid migration file name"));
    }
    let dir = cfg.migrations_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).or_else(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { config(format!("{file_name} already exists")) } else { Err(e.into()) }
    })?;
    std::io::Write::write_all(&mut f, sql.as_bytes())?;
    // Re-scan so a duplicate version is caught now, not at the next migrate.
    if let Err(e) = migration::scan(&dir) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

fn kind_word(k: ChangeKind) -> &'static str {
    match k { ChangeKind::Added => "Add", ChangeKind::Changed => "Change", ChangeKind::Removed => "Remove" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, not_null: bool, default: Option<&str>) -> Column {
        let mut c = Column { name: name.into(), data_type: ty.into(), not_null, default: default.map(Into::into), identity: None };
        normalize_serial(&mut c);
        c
    }
    fn model(tables: &[(&str, Vec<Column>)]) -> Model {
        tables.iter().map(|(t, c)| (("public".to_string(), t.to_string()), c.clone())).collect()
    }

    #[test]
    fn compares_tables_and_columns() {
        let dev = model(&[
            ("order", vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("note", "text", false, None), col("total", "numeric(10,2)", true, Some("0"))]),
            ("customer", vec![col("id", "bigint", true, None)]),
        ]);
        let migrations = model(&[
            ("order", vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("legacy", "text", false, None), col("total", "numeric(8,2)", false, None)]),
            ("cart", vec![col("id", "integer", true, None)]),
        ]);
        let changes = compare(&dev, &migrations);
        let get = |n: &str| changes.iter().find(|c| c.name == n).unwrap();

        let customer = get("public.customer");
        assert_eq!(customer.kind, ChangeKind::Added);
        assert!(!customer.destructive);
        assert_eq!(customer.sql, "CREATE TABLE public.customer (\n    id bigint NOT NULL\n);");

        let order = get("public.order");
        assert_eq!(order.kind, ChangeKind::Changed);
        assert!(order.destructive, "drops a column and changes a type");
        assert!(order.sql.contains("ALTER TABLE public.\"order\" ADD COLUMN note text;"), "{}", order.sql);
        assert!(order.sql.contains("ALTER COLUMN total TYPE numeric(10,2) USING total::numeric(10,2);"), "{}", order.sql);
        assert!(order.sql.contains("ALTER COLUMN total SET DEFAULT 0;"));
        assert!(order.sql.contains("ALTER COLUMN total SET NOT NULL;"));
        assert!(order.sql.contains("DROP COLUMN legacy;"));
        assert!(!order.sql.contains(" id "), "serial id is unchanged: {}", order.sql);

        let cart = get("public.cart");
        assert_eq!((cart.kind, cart.destructive), (ChangeKind::Removed, true));
        assert_eq!(changes.len(), 3);
        assert!(compare(&dev, &dev).is_empty());
    }

    #[test]
    fn serial_columns_render_as_serial() {
        let c = col("id", "bigint", true, Some("nextval('x'::regclass)"));
        assert_eq!(col_def(&c), "id bigserial");
    }
}
