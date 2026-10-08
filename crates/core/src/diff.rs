//! Schema diff (C11) and migration generation (C12).
//! Scope: tables, columns (type, nullability, default, identity, serial), constraints
//! (primary key, unique, check, exclusion, foreign key) and indexes.
//! Views, functions, sequences, enums, triggers and grants come later (architecture.md).

use crate::config::{role_name, Config, Role};
use crate::db::{self, quote_ident as q};
use crate::error::{config, Result};
use crate::migration;
use crate::runner::{self, Level, Log, MigrateOptions};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Constraint {
    pub name: String,
    /// pg_get_constraintdef, e.g. `PRIMARY KEY (id)`
    pub def: String,
    pub foreign: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Table {
    pub columns: Vec<Column>,
    pub constraints: Vec<Constraint>,
    /// index name -> pg_get_indexdef (indexes that back a constraint are left out)
    pub indexes: BTreeMap<String, String>,
}

/// (schema, table) -> table
pub type Model = BTreeMap<(String, String), Table>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Changed,
    Removed,
}

/// Statements are emitted phase by phase across all selected changes, so a foreign key to a
/// table created in the same migration comes after that table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// 0 drop constraints/indexes, 1 tables and columns, 2 keys/checks/indexes, 3 foreign keys, 4 drop tables
    pub phase: u8,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub id: String,
    pub object_type: String,
    pub name: String,
    pub kind: ChangeKind,
    pub destructive: bool,
    /// all steps joined, for display
    pub sql: String,
    pub steps: Vec<Step>,
}

pub async fn introspect(c: &Client, schemas: &[String], exclude_table: &str) -> Result<Model> {
    // Fully qualified names in every def, whatever the session's normal search_path is.
    c.batch_execute("SET search_path TO pg_catalog").await?;
    let mut model = Model::new();
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
    for r in rows {
        let t = model.entry((r.get(0), r.get(1))).or_default();
        let Some(name) = r.get::<_, Option<String>>(2) else { continue };
        let identity = match r.get::<_, Option<String>>(6).as_deref() {
            Some("a") => Some("always".to_string()),
            Some("d") => Some("by default".to_string()),
            _ => None,
        };
        let mut col = Column { name, data_type: r.get(3), not_null: r.get(4), default: r.get(5), identity };
        normalize_serial(&mut col);
        t.columns.push(col);
    }

    let rows = c
        .query(
            "select n.nspname::text, c.relname::text, con.conname::text, pg_get_constraintdef(con.oid, true), con.contype = 'f'
             from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
             where con.contype in ('p', 'u', 'c', 'f', 'x') and con.conislocal
               and c.relkind in ('r', 'p') and n.nspname = any($1) and c.relname <> $2
             order by 1, 2, 3",
            &[&schemas, &exclude_table],
        )
        .await?;
    for r in rows {
        if let Some(t) = model.get_mut(&(r.get(0), r.get(1))) {
            t.constraints.push(Constraint { name: r.get(2), def: r.get(3), foreign: r.get(4) });
        }
    }

    let rows = c
        .query(
            "select n.nspname::text, t.relname::text, i.relname::text, pg_get_indexdef(x.indexrelid)
             from pg_index x
             join pg_class i on i.oid = x.indexrelid
             join pg_class t on t.oid = x.indrelid
             join pg_namespace n on n.oid = t.relnamespace
             where t.relkind in ('r', 'p') and n.nspname = any($1) and t.relname <> $2
               and not exists (select 1 from pg_constraint con
                               where con.conindid = x.indexrelid and con.conrelid = x.indrelid and con.contype in ('p', 'u', 'x'))
             order by 1, 2, 3",
            &[&schemas, &exclude_table],
        )
        .await?;
    for r in rows {
        if let Some(t) = model.get_mut(&(r.get(0), r.get(1))) {
            t.indexes.insert(r.get(2), r.get(3));
        }
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

fn add_constraint(t: &str, c: &Constraint) -> Step {
    Step { phase: if c.foreign { 3 } else { 2 }, sql: format!("ALTER TABLE {t} ADD CONSTRAINT {} {};", q(&c.name), c.def) }
}

/// Changes that turn `target` (what the migrations produce) into `source` (what dev looks like).
pub fn compare(source: &Model, target: &Model) -> Vec<Change> {
    let mut out = Vec::new();
    for (key, new) in source {
        let name = format!("{}.{}", key.0, key.1);
        let t = format!("{}.{}", q(&key.0), q(&key.1));
        let mut steps = Vec::new();
        let mut destructive = false;
        let old = target.get(key);

        match old {
            None => {
                let body = new.columns.iter().map(|c| format!("    {}", col_def(c))).collect::<Vec<_>>().join(",\n");
                steps.push(Step { phase: 1, sql: format!("CREATE TABLE {t} (\n{body}\n);") });
            }
            Some(old) => {
                for c in &new.columns {
                    match old.columns.iter().find(|o| o.name == c.name) {
                        None => steps.push(Step { phase: 1, sql: format!("ALTER TABLE {t} ADD COLUMN {};", col_def(c)) }),
                        Some(o) if o == c => {}
                        Some(o) => destructive |= alter_column(&t, o, c, &mut steps),
                    }
                }
                for o in old.columns.iter().filter(|o| !new.columns.iter().any(|c| c.name == o.name)) {
                    destructive = true;
                    steps.push(Step { phase: 1, sql: format!("ALTER TABLE {t} DROP COLUMN {};", q(&o.name)) });
                }
            }
        }

        let empty = Table::default();
        let old_t = old.unwrap_or(&empty);
        for o in &old_t.constraints {
            match new.constraints.iter().find(|c| c.name == o.name) {
                Some(c) if c == o => {}
                _ => steps.push(Step { phase: 0, sql: format!("ALTER TABLE {t} DROP CONSTRAINT {};", q(&o.name)) }),
            }
        }
        for c in &new.constraints {
            if old_t.constraints.iter().find(|o| o.name == c.name) != Some(c) {
                steps.push(add_constraint(&t, c));
            }
        }
        for (iname, odef) in &old_t.indexes {
            if new.indexes.get(iname) != Some(odef) {
                steps.push(Step { phase: 0, sql: format!("DROP INDEX {}.{};", q(&key.0), q(iname)) });
            }
        }
        for (iname, def) in &new.indexes {
            if old_t.indexes.get(iname) != Some(def) {
                steps.push(Step { phase: 2, sql: format!("{def};") });
            }
        }

        if !steps.is_empty() {
            let kind = if old.is_none() { ChangeKind::Added } else { ChangeKind::Changed };
            out.push(change(&name, kind, destructive, steps));
        }
    }
    for key in target.keys().filter(|k| !source.contains_key(*k)) {
        let steps = vec![Step { phase: 4, sql: format!("DROP TABLE {}.{};", q(&key.0), q(&key.1)) }];
        out.push(change(&format!("{}.{}", key.0, key.1), ChangeKind::Removed, true, steps));
    }
    out
}

/// Returns true when the change may lose data (type or identity change).
fn alter_column(t: &str, o: &Column, c: &Column, steps: &mut Vec<Step>) -> bool {
    let col = q(&c.name);
    let mut sql = Vec::new();
    let mut destructive = false;
    if o.data_type != c.data_type || o.identity != c.identity {
        destructive = true;
        if o.identity.is_some() && c.identity.is_none() {
            sql.push(format!("ALTER TABLE {t} ALTER COLUMN {col} DROP IDENTITY;"));
        }
        if o.data_type != c.data_type {
            sql.push(format!("ALTER TABLE {t} ALTER COLUMN {col} TYPE {0} USING {col}::{0};", c.data_type));
        }
        if let (None, Some(i)) = (&o.identity, &c.identity) {
            sql.push(format!("ALTER TABLE {t} ALTER COLUMN {col} ADD GENERATED {} AS IDENTITY;", i.to_uppercase()));
        }
    }
    if o.default != c.default {
        sql.push(match &c.default {
            Some(d) => format!("ALTER TABLE {t} ALTER COLUMN {col} SET DEFAULT {d};"),
            None => format!("ALTER TABLE {t} ALTER COLUMN {col} DROP DEFAULT;"),
        });
    }
    if o.not_null != c.not_null && c.identity.is_none() {
        sql.push(format!("ALTER TABLE {t} ALTER COLUMN {col} {} NOT NULL;", if c.not_null { "SET" } else { "DROP" }));
    }
    steps.extend(sql.into_iter().map(|sql| Step { phase: 1, sql }));
    destructive
}

fn change(name: &str, kind: ChangeKind, destructive: bool, mut steps: Vec<Step>) -> Change {
    steps.sort_by_key(|s| s.phase);
    let sql = steps.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>().join("\n");
    Change { id: format!("table:{name}"), object_type: "Tables".into(), name: name.into(), kind, destructive, sql, steps }
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
    runner::reset_schemas(&s, &cfg.project.schemas).await?;
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
    let desc = check_description(description)?;
    let existing = migration::scan(&cfg.migrations_dir())?;
    let version = migration::next_version(&existing, time::OffsetDateTime::now_utc());
    let mut sql = format!("-- {desc}\n-- Written by LiftOff. Review before committing.\n");
    let mut summary: Vec<String> = changes
        .iter()
        .map(|c| format!("--   {} {}{}", kind_word(c.kind), c.name, if c.destructive { " (may lose data)" } else { "" }))
        .collect();
    summary.sort();
    sql.push_str(&format!("--\n{}\n", summary.join("\n")));
    for phase in 0..=4u8 {
        let stmts: Vec<&str> = changes.iter().flat_map(|c| c.steps.iter()).filter(|s| s.phase == phase).map(|s| s.sql.as_str()).collect();
        if !stmts.is_empty() {
            sql.push_str(&format!("\n{}\n", stmts.join("\n")));
        }
    }
    let file_name = format!("V{version}__{}.sql", desc.replace([' ', '-'], "_"));
    Ok(Generated { file_name, version, sql })
}

fn check_description(description: &str) -> Result<&str> {
    let desc = description.trim();
    if desc.is_empty() || desc.len() > 120 || !desc.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '_' || c == '-') {
        return config("describe the migration in up to 120 letters, digits, spaces, - or _");
    }
    Ok(desc)
}

/// A hand-written script (C20): versioned gets the next version, repeatable gets `R__`.
pub fn add(cfg: &Config, repeatable: bool, description: &str, sql: &str) -> Result<std::path::PathBuf> {
    let desc = check_description(description)?.replace([' ', '-'], "_");
    let file_name = if repeatable {
        format!("R__{desc}.sql")
    } else {
        let existing = migration::scan(&cfg.migrations_dir())?;
        format!("V{}__{desc}.sql", migration::next_version(&existing, time::OffsetDateTime::now_utc()))
    };
    let body = if sql.trim().is_empty() { format!("-- {}\n", description.trim()) } else { sql.to_string() };
    save(cfg, &file_name, &body)
}

/// The whole schema of an existing database as one script (F07): run nothing, then
/// `baseline` that database at the script's version so it never runs there.
pub async fn capture(cfg: &Config, env_name: Option<&str>, description: &str) -> Result<Generated> {
    let (name, env) = cfg.pick(env_name)?;
    let c = db::connect(&name, env).await?;
    let model = introspect(&c, &cfg.project.schemas, &cfg.project.history_table).await?;
    let changes = compare(&model, &Model::new());
    if changes.is_empty() {
        return config(format!("'{name}' has no tables in {} to capture", cfg.project.schemas.join(", ")));
    }
    generate(cfg, &changes, description)
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
    drop(f);
    // Re-scan so a duplicate version is caught now, not at the next migrate.
    if let Err(e) = migration::scan(&dir) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

fn kind_word(k: ChangeKind) -> &'static str {
    match k {
        ChangeKind::Added => "Add",
        ChangeKind::Changed => "Change",
        ChangeKind::Removed => "Remove",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, not_null: bool, default: Option<&str>) -> Column {
        let mut c = Column { name: name.into(), data_type: ty.into(), not_null, default: default.map(Into::into), identity: None };
        normalize_serial(&mut c);
        c
    }
    fn table(columns: Vec<Column>) -> Table {
        Table { columns, ..Default::default() }
    }
    fn model(tables: Vec<(&str, Table)>) -> Model {
        tables.into_iter().map(|(t, tb)| (("public".to_string(), t.to_string()), tb)).collect()
    }
    fn pk(name: &str, def: &str) -> Constraint {
        Constraint { name: name.into(), def: def.into(), foreign: false }
    }

    #[test]
    fn compares_tables_and_columns() {
        let dev = model(vec![
            ("order", table(vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("note", "text", false, None), col("total", "numeric(10,2)", true, Some("0"))])),
            ("customer", table(vec![col("id", "bigint", true, None)])),
        ]);
        let migrations = model(vec![
            ("order", table(vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("legacy", "text", false, None), col("total", "numeric(8,2)", false, None)])),
            ("cart", table(vec![col("id", "integer", true, None)])),
        ]);
        let changes = compare(&dev, &migrations);
        let get = |n: &str| changes.iter().find(|c| c.name == n).unwrap();

        let customer = get("public.customer");
        assert_eq!((customer.kind, customer.destructive), (ChangeKind::Added, false));
        assert_eq!(customer.sql, "CREATE TABLE public.customer (\n    id bigint NOT NULL\n);");

        let order = get("public.order");
        assert_eq!(order.kind, ChangeKind::Changed);
        assert!(order.destructive, "drops a column and changes a type");
        assert!(order.sql.contains("ALTER TABLE public.\"order\" ADD COLUMN note text;"), "{}", order.sql);
        assert!(order.sql.contains("ALTER COLUMN total TYPE numeric(10,2) USING total::numeric(10,2);"), "{}", order.sql);
        assert!(order.sql.contains("ALTER COLUMN total SET DEFAULT 0;"));
        assert!(order.sql.contains("ALTER COLUMN total SET NOT NULL;"));
        assert!(order.sql.contains("DROP COLUMN legacy;"));

        let cart = get("public.cart");
        assert_eq!((cart.kind, cart.destructive), (ChangeKind::Removed, true));
        assert_eq!(changes.len(), 3);
        assert!(compare(&dev, &dev).is_empty());
    }

    #[test]
    fn constraints_and_indexes_are_ordered_across_tables() {
        let mut orders = table(vec![col("id", "bigint", true, None), col("customer_id", "bigint", true, None)]);
        orders.constraints = vec![
            pk("orders_pkey", "PRIMARY KEY (id)"),
            Constraint { name: "orders_customer_fk".into(), def: "FOREIGN KEY (customer_id) REFERENCES public.customers(id)".into(), foreign: true },
        ];
        orders.indexes.insert("orders_customer_idx".into(), "CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id)".into());
        let mut customers = table(vec![col("id", "bigint", true, None)]);
        customers.constraints = vec![pk("customers_pkey", "PRIMARY KEY (id)")];
        let dev = model(vec![("orders", orders.clone()), ("customers", customers)]);

        let mut old_orders = orders.clone();
        old_orders.constraints = vec![pk("orders_pkey", "PRIMARY KEY (id, customer_id)")];
        old_orders.indexes.clear();
        let migrations = model(vec![("orders", old_orders)]);

        let changes = compare(&dev, &migrations);
        let orders = changes.iter().find(|c| c.name == "public.orders").unwrap();
        assert_eq!(orders.kind, ChangeKind::Changed);
        assert!(!orders.destructive, "constraint and index changes keep data");
        assert_eq!(orders.steps.iter().map(|s| s.phase).collect::<Vec<_>>(), [0, 2, 2, 3], "{:#?}", orders.steps);

        // Across tables: the new customers table comes before the foreign key that points at it.
        let cfg_free = generate_sql(&changes);
        let create = cfg_free.find("CREATE TABLE public.customers").unwrap();
        let fk = cfg_free.find("ADD CONSTRAINT orders_customer_fk").unwrap();
        let drop_pk = cfg_free.find("DROP CONSTRAINT orders_pkey").unwrap();
        assert!(drop_pk < create && create < fk, "{cfg_free}");
    }

    /// generate() without touching the filesystem.
    fn generate_sql(changes: &[Change]) -> String {
        (0..=4u8)
            .flat_map(|p| changes.iter().flat_map(|c| c.steps.iter()).filter(move |s| s.phase == p).map(|s| s.sql.clone()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn serial_columns_render_as_serial() {
        assert_eq!(col_def(&col("id", "bigint", true, Some("nextval('x'::regclass)"))), "id bigserial");
    }
}
