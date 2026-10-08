//! Schema diff (C11), migration and undo generation (C12), capture (F07).
//! Objects: tables (columns, identity, serial, defaults), constraints (pk, unique, check, exclusion,
//! foreign key), indexes, views, functions and procedures, enum types, standalone sequences.
//! Not yet: materialized views, triggers, domains, composite types, grants, comments, rename detection.

use crate::config::{role_name, Config, Role};
use crate::db::{self, quote_ident as q};
use crate::error::{config, Result};
use crate::migration;
use crate::runner::{self, Level, Log, MigrateOptions};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tokio_postgres::Client;

type Key = (String, String);

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    /// creation order in the source database; views are created in this order
    pub oid: u32,
    pub def: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Function {
    pub name: String,
    /// identity arguments, e.g. `amount numeric, rate numeric`
    pub args: String,
    pub procedure: bool,
    /// pg_get_functiondef: a complete CREATE OR REPLACE statement
    pub def: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sequence {
    pub data_type: String,
    pub start: i64,
    pub increment: i64,
    pub min: i64,
    pub max: i64,
    pub cache: i64,
    pub cycle: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Model {
    pub tables: BTreeMap<Key, Table>,
    pub views: BTreeMap<Key, View>,
    /// (schema, "name(args)") -> function
    pub functions: BTreeMap<Key, Function>,
    pub enums: BTreeMap<Key, Vec<String>>,
    pub sequences: BTreeMap<Key, Sequence>,
    /// (view, relation it reads from): views on tables and on other views
    pub view_deps: Vec<(Key, Key)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Changed,
    Removed,
}

// Statements run phase by phase across all selected changes, so dependencies line up:
// a foreign key after the table it points at, a view after the function it calls.
const P_DROP: u8 = 0; // views (cascade), constraints, indexes
const P_TYPES: u8 = 1; // enum types, sequences
const P_TABLES: u8 = 2;
const P_KEYS: u8 = 3; // pk, unique, check, exclusion, indexes
const P_FKS: u8 = 4;
const P_FUNCS: u8 = 5;
const P_VIEWS: u8 = 6;
const P_DROP_TABLES: u8 = 7;
const P_DROP_OTHER: u8 = 8; // functions, types, sequences
const PHASES: u8 = 9;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Step {
    pub phase: u8,
    /// order inside a phase (views: creation order in dev)
    #[serde(default)]
    pub order: u32,
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
    /// the reverse steps, for an undo script
    #[serde(default)]
    pub undo_steps: Vec<Step>,
    /// the object as the migrations build it (None when added)
    #[serde(default)]
    pub before: Option<String>,
    /// the object as dev has it (None when removed)
    #[serde(default)]
    pub after: Option<String>,
}

/* ---------- introspection ---------- */

const NOT_EXTENSION: &str = "not exists (select 1 from pg_depend e where e.objid = {oid} and e.deptype = 'e')";

pub async fn introspect(c: &Client, schemas: &[String], exclude_table: &str) -> Result<Model> {
    // Fully qualified names in every def, whatever the session's normal search_path is.
    c.batch_execute("SET search_path TO pg_catalog").await?;
    let mut m = Model::default();
    let p: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&schemas, &exclude_table];
    let p1: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&schemas];
    let not_ext = |oid: &str| NOT_EXTENSION.replace("{oid}", oid);

    let rows = c.query(&format!(
        "select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod),
                a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1) and c.relname <> $2 and {}
         order by 1, 2, a.attnum", not_ext("c.oid")), &p).await?;
    for r in rows {
        let t = m.tables.entry((r.get(0), r.get(1))).or_default();
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

    let rows = c.query(
        "select n.nspname::text, c.relname::text, con.conname::text, pg_get_constraintdef(con.oid, true), con.contype = 'f'
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         where con.contype in ('p', 'u', 'c', 'f', 'x') and con.conislocal
           and c.relkind in ('r', 'p') and n.nspname = any($1) and c.relname <> $2
         order by 1, 2, 3", &p).await?;
    for r in rows {
        if let Some(t) = m.tables.get_mut(&(r.get(0), r.get(1))) {
            t.constraints.push(Constraint { name: r.get(2), def: r.get(3), foreign: r.get(4) });
        }
    }

    let rows = c.query(
        "select n.nspname::text, t.relname::text, i.relname::text, pg_get_indexdef(x.indexrelid)
         from pg_index x
         join pg_class i on i.oid = x.indexrelid
         join pg_class t on t.oid = x.indrelid
         join pg_namespace n on n.oid = t.relnamespace
         where t.relkind in ('r', 'p') and n.nspname = any($1) and t.relname <> $2
           and not exists (select 1 from pg_constraint con
                           where con.conindid = x.indexrelid and con.conrelid = x.indrelid and con.contype in ('p', 'u', 'x'))
         order by 1, 2, 3", &p).await?;
    for r in rows {
        if let Some(t) = m.tables.get_mut(&(r.get(0), r.get(1))) {
            t.indexes.insert(r.get(2), r.get(3));
        }
    }

    let rows = c.query(&format!(
        "select n.nspname::text, c.relname::text, c.oid::oid, pg_get_viewdef(c.oid, true)
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'v' and n.nspname = any($1) and {}", not_ext("c.oid")), &p1).await?;
    for r in rows {
        m.views.insert((r.get(0), r.get(1)), View { oid: r.get(2), def: r.get::<_, String>(3).trim_end().trim_end_matches(';').to_string() });
    }

    let rows = c.query(
        "select distinct vn.nspname::text, v.relname::text, sn.nspname::text, s.relname::text
         from pg_depend d
         join pg_rewrite r on r.oid = d.objid
         join pg_class v on v.oid = r.ev_class
         join pg_namespace vn on vn.oid = v.relnamespace
         join pg_class s on s.oid = d.refobjid
         join pg_namespace sn on sn.oid = s.relnamespace
         where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
           and v.oid <> s.oid and v.relkind = 'v' and vn.nspname = any($1)", &p1).await?;
    for r in rows {
        m.view_deps.push(((r.get(0), r.get(1)), (r.get(2), r.get(3))));
    }

    let rows = c.query(&format!(
        "select n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid), p.prokind = 'p', pg_get_functiondef(p.oid)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.prokind in ('f', 'p') and n.nspname = any($1) and {}", not_ext("p.oid")), &p1).await?;
    for r in rows {
        let (name, args): (String, String) = (r.get(1), r.get(2));
        let def = format!("{};", r.get::<_, String>(4).trim_end());
        m.functions.insert((r.get(0), format!("{name}({args})")), Function { name, args, procedure: r.get(3), def });
    }

    let rows = c.query(&format!(
        "select n.nspname::text, t.typname::text, array_agg(e.enumlabel::text order by e.enumsortorder)
         from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = any($1) and {}
         group by 1, 2", not_ext("t.oid")), &p1).await?;
    for r in rows {
        m.enums.insert((r.get(0), r.get(1)), r.get(2));
    }

    // Standalone sequences only: serial (deptype a) and identity (i) sequences come with their column.
    let rows = c.query(&format!(
        "select n.nspname::text, c.relname::text, format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
         from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1) and {}
           and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))", not_ext("c.oid")), &p1).await?;
    for r in rows {
        m.sequences.insert((r.get(0), r.get(1)), Sequence {
            data_type: r.get(2), start: r.get(3), increment: r.get(4), min: r.get(5), max: r.get(6), cache: r.get(7), cycle: r.get(8),
        });
    }
    Ok(m)
}

/// `integer DEFAULT nextval('t_id_seq'::regclass)` -> `serial`, so the owned sequence comes along.
/// ponytail: assumes the sequence is the column's own; standalone sequences are diffed separately.
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

/* ---------- DDL text ---------- */

fn qk(k: &Key) -> String {
    format!("{}.{}", q(&k.0), q(&k.1))
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
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

fn create_table(t: &str, tb: &Table) -> String {
    let body = tb.columns.iter().map(|c| format!("    {}", col_def(c))).collect::<Vec<_>>().join(",\n");
    format!("CREATE TABLE {t} (\n{body}\n);")
}

fn add_constraint(t: &str, c: &Constraint) -> Step {
    Step { phase: if c.foreign { P_FKS } else { P_KEYS }, order: 0, sql: format!("ALTER TABLE {t} ADD CONSTRAINT {} {};", q(&c.name), c.def) }
}

/// The whole table as one readable block: for the side-by-side view.
fn table_ddl(k: &Key, tb: &Table) -> String {
    let t = qk(k);
    let mut out = vec![create_table(&t, tb)];
    out.extend(tb.constraints.iter().map(|c| add_constraint(&t, c).sql));
    out.extend(tb.indexes.values().map(|d| format!("{d};")));
    out.join("\n")
}

fn view_ddl(k: &Key, v: &View) -> String {
    format!("CREATE VIEW {} AS\n{};", qk(k), v.def)
}

fn enum_ddl(k: &Key, labels: &[String]) -> String {
    format!("CREATE TYPE {} AS ENUM ({});", qk(k), labels.iter().map(|l| lit(l)).collect::<Vec<_>>().join(", "))
}

fn sequence_clauses(s: &Sequence) -> String {
    format!(
        "AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {} {}",
        s.data_type, s.increment, s.min, s.max, s.cache, if s.cycle { "CYCLE" } else { "NO CYCLE" }
    )
}

fn sequence_ddl(k: &Key, s: &Sequence) -> String {
    format!("CREATE SEQUENCE {} {} START WITH {};", qk(k), sequence_clauses(s), s.start)
}

fn function_drop(k: &Key, f: &Function) -> String {
    format!("DROP {} {}.{}({});", if f.procedure { "PROCEDURE" } else { "FUNCTION" }, q(&k.0), q(&f.name), f.args)
}

/* ---------- compare ---------- */

/// Changes that turn `target` (what the migrations build) into `source` (what dev has),
/// each with the reverse steps for an undo script.
pub fn diff(source: &Model, target: &Model) -> Vec<Change> {
    let mut forward = compare(source, target);
    let backward = compare(target, source);
    for c in &mut forward {
        if let Some(b) = backward.iter().find(|b| b.id == c.id) {
            c.undo_steps = b.steps.clone();
        }
    }
    forward
}

fn compare(source: &Model, target: &Model) -> Vec<Change> {
    let mut out: Vec<Change> = Vec::new();
    // Relations whose change breaks views reading from them: the views are dropped and recreated.
    let mut triggers: Vec<(usize, Key)> = Vec::new();

    for (k, labels) in &source.enums {
        let name = format!("{}.{}", k.0, k.1);
        match target.enums.get(k) {
            None => out.push(change("type", "Types", &name, ChangeKind::Added, false, vec![step(P_TYPES, enum_ddl(k, labels))], None, Some(enum_ddl(k, labels)))),
            Some(old) if old == labels => {}
            Some(old) => {
                let mut steps = Vec::new();
                let mut destructive = false;
                if old.iter().any(|l| !labels.contains(l)) || old.iter().filter(|l| labels.contains(l)).ne(labels.iter().filter(|l| old.contains(l))) {
                    destructive = true;
                    steps.push(step(P_TYPES, format!("-- {}: removing or reordering enum values cannot be done automatically; write it by hand.", qk(k))));
                }
                for (i, l) in labels.iter().enumerate().filter(|(_, l)| !old.contains(l)) {
                    let pos = match i {
                        0 => labels.get(1).map(|n| format!(" BEFORE {}", lit(n))).unwrap_or_default(),
                        _ => format!(" AFTER {}", lit(&labels[i - 1])),
                    };
                    steps.push(step(P_TYPES, format!("ALTER TYPE {} ADD VALUE IF NOT EXISTS {}{pos};", qk(k), lit(l))));
                }
                out.push(change("type", "Types", &name, ChangeKind::Changed, destructive, steps, Some(enum_ddl(k, old)), Some(enum_ddl(k, labels))));
            }
        }
    }
    for k in target.enums.keys().filter(|k| !source.enums.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, format!("DROP TYPE {};", qk(k)))];
        out.push(change("type", "Types", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(enum_ddl(k, &target.enums[k])), None));
    }

    for (k, s) in &source.sequences {
        let name = format!("{}.{}", k.0, k.1);
        match target.sequences.get(k) {
            None => out.push(change("sequence", "Sequences", &name, ChangeKind::Added, false, vec![step(P_TYPES, sequence_ddl(k, s))], None, Some(sequence_ddl(k, s)))),
            Some(old) if old == s => {}
            Some(old) => {
                let steps = vec![step(P_TYPES, format!("ALTER SEQUENCE {} {};", qk(k), sequence_clauses(s)))];
                out.push(change("sequence", "Sequences", &name, ChangeKind::Changed, false, steps, Some(sequence_ddl(k, old)), Some(sequence_ddl(k, s))));
            }
        }
    }
    for k in target.sequences.keys().filter(|k| !source.sequences.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, format!("DROP SEQUENCE {};", qk(k)))];
        out.push(change("sequence", "Sequences", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(sequence_ddl(k, &target.sequences[k])), None));
    }

    for (k, new) in &source.tables {
        let name = format!("{}.{}", k.0, k.1);
        let t = qk(k);
        let mut steps = Vec::new();
        let mut destructive = false;
        let old = target.tables.get(k);
        match old {
            None => steps.push(step(P_TABLES, create_table(&t, new))),
            Some(old) => {
                for c in &new.columns {
                    match old.columns.iter().find(|o| o.name == c.name) {
                        None => steps.push(step(P_TABLES, format!("ALTER TABLE {t} ADD COLUMN {};", col_def(c)))),
                        Some(o) if o == c => {}
                        Some(o) => destructive |= alter_column(&t, o, c, &mut steps),
                    }
                }
                for o in old.columns.iter().filter(|o| !new.columns.iter().any(|c| c.name == o.name)) {
                    destructive = true;
                    steps.push(step(P_TABLES, format!("ALTER TABLE {t} DROP COLUMN {};", q(&o.name))));
                }
            }
        }
        let empty = Table::default();
        let old_t = old.unwrap_or(&empty);
        for o in &old_t.constraints {
            match new.constraints.iter().find(|c| c.name == o.name) {
                Some(c) if c == o => {}
                _ => steps.push(step(P_DROP, format!("ALTER TABLE {t} DROP CONSTRAINT {};", q(&o.name)))),
            }
        }
        for c in &new.constraints {
            if old_t.constraints.iter().find(|o| o.name == c.name) != Some(c) {
                steps.push(add_constraint(&t, c));
            }
        }
        for (iname, odef) in &old_t.indexes {
            if new.indexes.get(iname) != Some(odef) {
                steps.push(step(P_DROP, format!("DROP INDEX {}.{};", q(&k.0), q(iname))));
            }
        }
        for (iname, def) in &new.indexes {
            if old_t.indexes.get(iname) != Some(def) {
                steps.push(step(P_KEYS, format!("{def};")));
            }
        }
        if !steps.is_empty() {
            let kind = if old.is_none() { ChangeKind::Added } else { ChangeKind::Changed };
            if destructive {
                triggers.push((out.len(), k.clone()));
            }
            out.push(change("table", "Tables", &name, kind, destructive, steps, old.map(|o| table_ddl(k, o)), Some(table_ddl(k, new))));
        }
    }
    for k in target.tables.keys().filter(|k| !source.tables.contains_key(*k)) {
        triggers.push((out.len(), k.clone()));
        let steps = vec![step(P_DROP_TABLES, format!("DROP TABLE {};", qk(k)))];
        out.push(change("table", "Tables", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(table_ddl(k, &target.tables[k])), None));
    }

    for (k, f) in &source.functions {
        let name = format!("{}.{}", k.0, k.1);
        match target.functions.get(k) {
            None => out.push(change("function", "Functions", &name, ChangeKind::Added, false, vec![step(P_FUNCS, f.def.clone())], None, Some(f.def.clone()))),
            Some(old) if old == f => {}
            // ponytail: CREATE OR REPLACE cannot change the return type; that needs a hand-written drop + create.
            Some(old) => out.push(change("function", "Functions", &name, ChangeKind::Changed, false, vec![step(P_FUNCS, f.def.clone())], Some(old.def.clone()), Some(f.def.clone()))),
        }
    }
    for (k, f) in target.functions.iter().filter(|(k, _)| !source.functions.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, function_drop(k, f))];
        out.push(change("function", "Functions", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(f.def.clone()), None));
    }

    let create_view = |k: &Key| {
        let v = &source.views[k];
        Step { phase: P_VIEWS, order: v.oid, sql: view_ddl(k, v) }
    };
    let drop_view = |k: &Key| step(P_DROP, format!("DROP VIEW IF EXISTS {} CASCADE;", qk(k)));
    for (k, v) in &source.views {
        let name = format!("{}.{}", k.0, k.1);
        match target.views.get(k) {
            None => out.push(change("view", "Views", &name, ChangeKind::Added, false, vec![create_view(k)], None, Some(view_ddl(k, v)))),
            Some(old) if old.def == v.def => {}
            Some(old) => {
                triggers.push((out.len(), k.clone()));
                out.push(change("view", "Views", &name, ChangeKind::Changed, false, vec![drop_view(k), create_view(k)], Some(view_ddl(k, old)), Some(view_ddl(k, v))));
            }
        }
    }
    for (k, v) in target.views.iter().filter(|(k, _)| !source.views.contains_key(*k)) {
        triggers.push((out.len(), k.clone()));
        out.push(change("view", "Views", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, false, vec![drop_view(k)], Some(view_ddl(k, v)), None));
    }

    // Views reading (directly or through other views) from a changed relation are dropped with
    // CASCADE and recreated by that change, so selecting the change alone gives a working script.
    for (i, rel) in triggers {
        let mut affected: BTreeSet<Key> = BTreeSet::new();
        let mut frontier = vec![rel];
        while let Some(r) = frontier.pop() {
            for (v, _) in target.view_deps.iter().filter(|(_, src)| *src == r) {
                if affected.insert(v.clone()) {
                    frontier.push(v.clone());
                }
            }
        }
        for v in affected {
            let own_change = out.iter().any(|c| c.id == format!("view:{}.{}", v.0, v.1));
            if source.views.contains_key(&v) && !own_change {
                out[i].steps.push(drop_view(&v));
                out[i].steps.push(create_view(&v));
                out[i].steps.sort_by_key(|s| (s.phase, s.order));
                out[i].sql = joined(&out[i].steps);
            }
        }
    }
    out
}

fn step(phase: u8, sql: String) -> Step {
    Step { phase, order: 0, sql }
}

fn joined(steps: &[Step]) -> String {
    steps.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>().join("\n")
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
    steps.extend(sql.into_iter().map(|sql| step(P_TABLES, sql)));
    destructive
}

#[allow(clippy::too_many_arguments)]
fn change(prefix: &str, object_type: &str, name: &str, kind: ChangeKind, destructive: bool, mut steps: Vec<Step>, before: Option<String>, after: Option<String>) -> Change {
    steps.sort_by_key(|s| (s.phase, s.order));
    Change {
        id: format!("{prefix}:{name}"),
        object_type: object_type.into(),
        name: name.into(),
        kind,
        destructive,
        sql: joined(&steps),
        steps,
        undo_steps: vec![],
        before,
        after,
    }
}

/* ---------- scratch rebuild + comparisons ---------- */

/// Picks and checks the scratch environment: it gets erased.
pub(crate) fn scratch_env<'a>(cfg: &'a Config, scratch: Option<&str>) -> Result<(String, &'a crate::config::Environment)> {
    let (name, env) = cfg.pick_role(scratch, Role::Scratch)?;
    if env.role != Role::Scratch && !env.allow_clean {
        return config(format!("'{name}' has role '{}' and allow_clean is off; refusing to rebuild it as a scratch database", role_name(env.role)));
    }
    Ok((name, env))
}

/// Erases the scratch database and runs the migrations into it (up to `target` when given).
pub(crate) async fn rebuild_scratch(cfg: &Config, name: &str, env: &crate::config::Environment, target: Option<&str>, log: Log<'_>) -> Result<Client> {
    log(Level::Info, &format!("Rebuilding scratch database '{name}' from migrations{}", target.map(|t| format!(" up to {t}")).unwrap_or_default()));
    let s = db::connect(name, env).await?;
    runner::reset_schemas(&s, &cfg.project.schemas).await?;
    let opts = MigrateOptions { out_of_order: true, target: target.map(Into::into), ..Default::default() };
    runner::migrate(cfg, Some(name), opts, log).await?;
    Ok(s)
}

pub(crate) async fn model_of(cfg: &Config, c: &Client) -> Result<Model> {
    introspect(c, &cfg.project.schemas, &cfg.project.history_table).await
}

/// Rebuilds the scratch database from the project's migrations, then diffs dev against it.
pub async fn dev_vs_migrations(cfg: &Config, dev: Option<&str>, scratch: Option<&str>, log: Log<'_>) -> Result<Vec<Change>> {
    let (dev_name, dev_env) = cfg.pick_role(dev, Role::Dev)?;
    let (scratch_name, scratch_env) = scratch_env(cfg, scratch)?;
    if dev_name == scratch_name {
        return config("the dev and scratch environments must be different databases");
    }
    let s = rebuild_scratch(cfg, &scratch_name, scratch_env, None, log).await?;
    log(Level::Info, &format!("Comparing '{dev_name}' with the migrations"));
    let d = db::connect(&dev_name, dev_env).await?;
    let changes = diff(&model_of(cfg, &d).await?, &model_of(cfg, &s).await?);
    log(Level::Info, &format!("{} difference(s)", changes.len()));
    Ok(changes)
}

/* ---------- generate ---------- */

#[derive(Debug, Serialize)]
pub struct Generated {
    pub file_name: String,
    pub version: String,
    pub sql: String,
    /// the matching U script, when asked for
    pub undo: Option<GeneratedUndo>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedUndo {
    pub file_name: String,
    pub sql: String,
}

fn render(header: &str, changes: &[Change], steps_of: impl Fn(&Change) -> &[Step]) -> String {
    let mut sql = format!("{header}\n");
    let mut summary: Vec<String> = changes
        .iter()
        .map(|c| format!("--   {} {} {}{}", kind_word(c.kind), c.object_type.to_lowercase().trim_end_matches('s'), c.name, if c.destructive { " (may lose data)" } else { "" }))
        .collect();
    summary.sort();
    sql.push_str(&format!("--\n{}\n", summary.join("\n")));
    let mut seen = BTreeSet::new();
    for phase in 0..PHASES {
        let mut steps: Vec<&Step> = changes.iter().flat_map(|c| steps_of(c).iter()).filter(|s| s.phase == phase).collect();
        steps.sort_by_key(|s| s.order);
        // A view recreated by two changes appears once.
        let stmts: Vec<&str> = steps.iter().map(|s| s.sql.as_str()).filter(|s| seen.insert(s.to_string())).collect();
        if !stmts.is_empty() {
            sql.push_str(&format!("\n{}\n", stmts.join("\n")));
        }
    }
    sql
}

/// Renders the selected changes as the next versioned migration (not yet written to disk),
/// plus the undo script when `with_undo`.
pub fn generate(cfg: &Config, changes: &[Change], description: &str, with_undo: bool) -> Result<Generated> {
    if changes.is_empty() {
        return config("nothing selected to put in the migration");
    }
    let desc = check_description(description)?;
    let existing = migration::scan(&cfg.migrations_dir())?;
    let version = migration::next_version(&existing, time::OffsetDateTime::now_utc());
    let slug = desc.replace([' ', '-'], "_");
    let sql = render(&format!("-- {desc}\n-- Written by LiftOff. Review before committing."), changes, |c| &c.steps);
    let undo = with_undo.then(|| GeneratedUndo {
        file_name: format!("U{version}__{slug}.sql"),
        sql: render(
            &format!("-- Undo: {desc}\n-- Written by LiftOff. Data removed by the migration is not restored."),
            changes,
            |c| &c.undo_steps,
        ),
    });
    Ok(Generated { file_name: format!("V{version}__{slug}.sql"), version, sql, undo })
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
    let model = model_of(cfg, &c).await?;
    let changes = compare(&model, &Model::default());
    if changes.is_empty() {
        return config(format!("'{name}' has nothing in {} to capture", cfg.project.schemas.join(", ")));
    }
    generate(cfg, &changes, description, false)
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
    fn key(t: &str) -> Key {
        ("public".to_string(), t.to_string())
    }
    fn tables(tables: Vec<(&str, Table)>) -> Model {
        Model { tables: tables.into_iter().map(|(t, tb)| (key(t), tb)).collect(), ..Default::default() }
    }
    fn table(columns: Vec<Column>) -> Table {
        Table { columns, ..Default::default() }
    }
    fn pk(name: &str, def: &str) -> Constraint {
        Constraint { name: name.into(), def: def.into(), foreign: false }
    }
    fn all_sql(changes: &[Change]) -> String {
        render("", changes, |c| &c.steps)
    }

    #[test]
    fn compares_tables_and_columns() {
        let dev = tables(vec![
            ("order", table(vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("note", "text", false, None), col("total", "numeric(10,2)", true, Some("0"))])),
            ("customer", table(vec![col("id", "bigint", true, None)])),
        ]);
        let migrations = tables(vec![
            ("order", table(vec![col("id", "integer", true, Some("nextval('order_id_seq'::regclass)")), col("legacy", "text", false, None), col("total", "numeric(8,2)", false, None)])),
            ("cart", table(vec![col("id", "integer", true, None)])),
        ]);
        let changes = diff(&dev, &migrations);
        let get = |n: &str| changes.iter().find(|c| c.name == n).unwrap();

        let customer = get("public.customer");
        assert_eq!((customer.kind, customer.destructive), (ChangeKind::Added, false));
        assert_eq!(customer.sql, "CREATE TABLE public.customer (\n    id bigint NOT NULL\n);");
        assert_eq!(customer.undo_steps[0].sql, "DROP TABLE public.customer;");
        assert!(customer.before.is_none() && customer.after.as_deref().unwrap().starts_with("CREATE TABLE public.customer"));

        let order = get("public.order");
        assert!(order.destructive, "drops a column and changes a type");
        for s in ["ADD COLUMN note text;", "ALTER COLUMN total TYPE numeric(10,2) USING total::numeric(10,2);", "ALTER COLUMN total SET DEFAULT 0;", "ALTER COLUMN total SET NOT NULL;", "DROP COLUMN legacy;"] {
            assert!(order.sql.contains(s), "{s} in {}", order.sql);
        }
        assert!(order.undo_steps.iter().any(|s| s.sql.contains("ADD COLUMN legacy text")), "{:#?}", order.undo_steps);

        assert_eq!((get("public.cart").kind, get("public.cart").destructive), (ChangeKind::Removed, true));
        assert_eq!(changes.len(), 3);
        assert!(diff(&dev, &dev).is_empty());
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
        let dev = tables(vec![("orders", orders.clone()), ("customers", customers)]);
        let mut old_orders = orders;
        old_orders.constraints = vec![pk("orders_pkey", "PRIMARY KEY (id, customer_id)")];
        old_orders.indexes.clear();
        let changes = diff(&dev, &tables(vec![("orders", old_orders)]));

        let o = changes.iter().find(|c| c.name == "public.orders").unwrap();
        assert!(!o.destructive, "constraint and index changes keep data");
        assert_eq!(o.steps.iter().map(|s| s.phase).collect::<Vec<_>>(), [P_DROP, P_KEYS, P_KEYS, P_FKS]);
        let sql = all_sql(&changes);
        let (drop_pk, create, fk) = (sql.find("DROP CONSTRAINT orders_pkey").unwrap(), sql.find("CREATE TABLE public.customers").unwrap(), sql.find("ADD CONSTRAINT orders_customer_fk").unwrap());
        assert!(drop_pk < create && create < fk, "{sql}");
    }

    #[test]
    fn views_are_rebuilt_when_what_they_read_changes() {
        let v = |oid, def: &str| View { oid, def: def.into() };
        let t_new = table(vec![col("id", "bigint", true, None), col("total", "numeric(12,2)", false, None)]);
        let t_old = table(vec![col("id", "bigint", true, None), col("total", "numeric(10,2)", false, None)]);
        let mut dev = tables(vec![("orders", t_new)]);
        dev.views.insert(key("order_totals"), v(10, " SELECT id, total FROM public.orders"));
        dev.views.insert(key("big_orders"), v(11, " SELECT id FROM public.order_totals WHERE total > 100"));
        let mut mig = tables(vec![("orders", t_old)]);
        mig.views = dev.views.clone();
        mig.view_deps = vec![(key("order_totals"), key("orders")), (key("big_orders"), key("order_totals"))];

        let changes = diff(&dev, &mig);
        assert_eq!(changes.len(), 1, "only the table changed: {changes:#?}");
        let sql = &changes[0].sql;
        let drop1 = sql.find("DROP VIEW IF EXISTS public.order_totals CASCADE").unwrap();
        let alter = sql.find("TYPE numeric(12,2)").unwrap();
        let create1 = sql.find("CREATE VIEW public.order_totals").unwrap();
        let create2 = sql.find("CREATE VIEW public.big_orders").unwrap();
        assert!(drop1 < alter && alter < create1 && create1 < create2, "{sql}");
    }

    #[test]
    fn enums_sequences_functions() {
        let mut dev = Model::default();
        dev.enums.insert(key("mood"), vec!["sad".into(), "ok".into(), "happy".into()]);
        dev.sequences.insert(key("invoice_no"), Sequence { data_type: "bigint".into(), start: 1000, increment: 1, min: 1, max: i64::MAX, cache: 1, cycle: false });
        let f = Function { name: "tax".into(), args: "amount numeric".into(), procedure: false, def: "CREATE OR REPLACE FUNCTION public.tax(amount numeric) RETURNS numeric LANGUAGE sql AS $$ select amount * 0.21 $$;".into() };
        dev.functions.insert(("public".into(), "tax(amount numeric)".into()), f.clone());
        let mut mig = Model::default();
        mig.enums.insert(key("mood"), vec!["sad".into(), "happy".into()]);
        let mut old_f = f;
        old_f.def = old_f.def.replace("0.21", "0.19");
        mig.functions.insert(("public".into(), "tax(amount numeric)".into()), old_f);

        let changes = diff(&dev, &mig);
        let get = |id: &str| changes.iter().find(|c| c.id == id).unwrap();
        assert_eq!(get("type:public.mood").sql, "ALTER TYPE public.mood ADD VALUE IF NOT EXISTS 'ok' AFTER 'sad';");
        assert!(!get("type:public.mood").destructive);
        assert!(get("sequence:public.invoice_no").sql.starts_with("CREATE SEQUENCE public.invoice_no AS bigint INCREMENT BY 1"));
        assert!(get("function:public.tax(amount numeric)").sql.contains("0.21"));
        assert!(get("function:public.tax(amount numeric)").undo_steps[0].sql.contains("0.19"));

        // Removing an enum value cannot be automated: flagged, not silently skipped.
        let back = diff(&mig, &dev);
        assert!(back.iter().find(|c| c.id == "type:public.mood").unwrap().destructive);
        assert!(back.iter().any(|c| c.sql == "DROP SEQUENCE public.invoice_no;"));
    }

    #[test]
    fn serial_columns_render_as_serial() {
        assert_eq!(col_def(&col("id", "bigint", true, Some("nextval('x'::regclass)"))), "id bigserial");
    }
}
