//! Schema diff (C11), migration and undo generation (C12), capture (F07).
//! Objects: extensions, tables (columns, identity, serial, defaults, partitioning), constraints (pk,
//! unique, check, exclusion, foreign key), indexes, views and materialized views, functions and
//! procedures, triggers, enum types, domains, standalone sequences, grants and comments.
//! Anything else in the managed schemas is counted and reported as "not compared", never silently
//! skipped (row-level security, rules, composite and range types, aggregates, operators, foreign tables,
//! column privileges). No rename detection.

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
    /// partitioned parent: `RANGE (created_at)`
    pub partition_by: Option<String>,
    /// partition: parent and bound, `FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`
    pub partition_of: Option<(Key, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    /// creation order in the source database; views are created in this order
    pub oid: u32,
    pub def: String,
    pub materialized: bool,
    /// materialized views only: index name -> definition
    pub indexes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Domain {
    pub base: String,
    pub default: Option<String>,
    pub not_null: bool,
    /// constraint name -> `CHECK (...)`
    pub checks: BTreeMap<String, String>,
}

/// One privilege: `GRANT privilege ON object TO grantee [WITH GRANT OPTION]`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Grant {
    /// `TABLE public.orders`, `SEQUENCE …`, `FUNCTION public.tax(amount numeric)`
    pub object: String,
    pub grantee: String,
    pub privilege: String,
    pub grantable: bool,
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
    /// extension name -> schema
    pub extensions: BTreeMap<String, String>,
    pub domains: BTreeMap<Key, Domain>,
    /// (schema, table, trigger name) -> CREATE TRIGGER …
    pub triggers: BTreeMap<(String, String, String), String>,
    pub grants: BTreeSet<Grant>,
    /// `TABLE public.orders`, `COLUMN public.orders.note`, … -> comment text
    pub comments: BTreeMap<String, String>,
    /// every object that can carry a grant or comment, by the same names
    pub objects: BTreeSet<String>,
    /// what exists but is not compared: (what, how many)
    pub not_compared: Vec<(String, i64)>,
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
const P_DROP: u8 = 0; // views (cascade), triggers, constraints, indexes
const P_TYPES: u8 = 1; // extensions, enum types, domains, sequences
const P_TABLES: u8 = 2; // parents before partitions (order)
const P_KEYS: u8 = 3; // pk, unique, check, exclusion, indexes
const P_FKS: u8 = 4;
const P_FUNCS: u8 = 5;
const P_VIEWS: u8 = 6; // views and materialized views, in creation order
const P_TRIGGERS: u8 = 7;
const P_GRANTS: u8 = 8; // grants and comments, once every object exists
const P_DROP_TABLES: u8 = 9;
const P_DROP_OTHER: u8 = 10; // functions, types, domains, sequences, extensions
const PHASES: u8 = 11;

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
                a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text,
                case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,
                pn.nspname::text, pc.relname::text, pg_get_expr(c.relpartbound, c.oid),
                a.attislocal
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         left join pg_inherits i on i.inhrelid = c.oid and c.relispartition
         left join pg_class pc on pc.oid = i.inhparent
         left join pg_namespace pn on pn.oid = pc.relnamespace
         where c.relkind in ('r', 'p') and n.nspname = any($1) and c.relname <> $2 and {}
         order by 1, 2, a.attnum", not_ext("c.oid")), &p).await?;
    for r in rows {
        let t = m.tables.entry((r.get(0), r.get(1))).or_default();
        t.partition_by = r.get(7);
        if let (Some(ps), Some(pt), Some(bound)) = (r.get::<_, Option<String>>(8), r.get::<_, Option<String>>(9), r.get::<_, Option<String>>(10)) {
            t.partition_of = Some(((ps, pt), bound));
        }
        let Some(name) = r.get::<_, Option<String>>(2) else { continue };
        // A partition's inherited columns come from its parent.
        if t.partition_of.is_some() && !r.get::<_, Option<bool>>(11).unwrap_or(true) {
            continue;
        }
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
         where t.relkind in ('r', 'p', 'm') and n.nspname = any($1) and t.relname <> $2
           and not i.relispartition
           and not exists (select 1 from pg_constraint con
                           where con.conindid = x.indexrelid and con.conrelid = x.indrelid and con.contype in ('p', 'u', 'x'))
         order by 1, 2, 3", &p).await?;
    let mut view_indexes: Vec<(Key, String, String)> = Vec::new();
    for r in rows {
        let key: Key = (r.get(0), r.get(1));
        match m.tables.get_mut(&key) {
            Some(t) => {
                t.indexes.insert(r.get(2), r.get(3));
            }
            None => view_indexes.push((key, r.get(2), r.get(3))),
        }
    }

    let rows = c.query(&format!(
        "select n.nspname::text, c.relname::text, c.oid::oid, pg_get_viewdef(c.oid, true), c.relkind = 'm'
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('v', 'm') and n.nspname = any($1) and {}", not_ext("c.oid")), &p1).await?;
    for r in rows {
        let def = r.get::<_, String>(3).trim_end().trim_end_matches(';').to_string();
        m.views.insert((r.get(0), r.get(1)), View { oid: r.get(2), def, materialized: r.get(4), indexes: BTreeMap::new() });
    }
    for (key, name, def) in view_indexes {
        if let Some(v) = m.views.get_mut(&key) {
            v.indexes.insert(name, def);
        }
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
           and v.oid <> s.oid and v.relkind in ('v', 'm') and vn.nspname = any($1)", &p1).await?;
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

    for r in c.query("select e.extname::text, n.nspname::text from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                      where e.extname <> 'plpgsql' and n.nspname = any($1)", &p1).await? {
        m.extensions.insert(r.get(0), r.get(1));
    }

    let rows = c.query(&format!(
        "select n.nspname::text, t.typname::text, format_type(t.typbasetype, t.typtypmod), t.typdefault, t.typnotnull
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where t.typtype = 'd' and n.nspname = any($1) and {}", not_ext("t.oid")), &p1).await?;
    for r in rows {
        m.domains.insert((r.get(0), r.get(1)), Domain { base: r.get(2), default: r.get(3), not_null: r.get(4), checks: BTreeMap::new() });
    }
    for r in c.query(
        "select n.nspname::text, t.typname::text, con.conname::text, pg_get_constraintdef(con.oid, true)
         from pg_constraint con join pg_type t on t.oid = con.contypid join pg_namespace n on n.oid = t.typnamespace
         where con.contype = 'c' and n.nspname = any($1)", &p1).await? {
        if let Some(d) = m.domains.get_mut(&(r.get(0), r.get(1))) {
            d.checks.insert(r.get(2), r.get(3));
        }
    }

    // Triggers a partition inherits from its parent are created with the parent's.
    for r in c.query(
        "select n.nspname::text, c.relname::text, t.tgname::text, pg_get_triggerdef(t.oid, true)
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where not t.tgisinternal and t.tgparentid = 0 and n.nspname = any($1) and c.relname <> $2", &p).await? {
        m.triggers.insert((r.get(0), r.get(1), r.get(2)), format!("{};", r.get::<_, String>(3)));
    }

    // Grants: owners' own privileges are implied, so they are left out.
    let rows = c.query(&format!(
        "select case c.relkind when 'S' then 'SEQUENCE ' else 'TABLE ' end || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type::text, a.is_grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
         where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname = any($1) and c.relname <> $2 and a.grantee <> c.relowner and {}
         union all
         select case p.prokind when 'p' then 'PROCEDURE ' else 'FUNCTION ' end || quote_ident(n.nspname) || '.' || quote_ident(p.proname)
                  || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type::text, a.is_grantable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
         where p.prokind in ('f', 'p') and n.nspname = any($1) and a.grantee <> p.proowner and {}",
        not_ext("c.oid"), not_ext("p.oid")), &p).await?;
    for r in rows {
        m.grants.insert(Grant { object: r.get(0), grantee: r.get(1), privilege: r.get(2), grantable: r.get(3) });
    }

    // Every object that can carry a comment, named the way COMMENT ON names it, with its comment.
    let rows = c.query(&format!(
        "select case c.relkind when 'v' then 'VIEW ' when 'm' then 'MATERIALIZED VIEW ' when 'S' then 'SEQUENCE ' else 'TABLE ' end
                  || quote_ident(n.nspname) || '.' || quote_ident(c.relname), obj_description(c.oid, 'pg_class')
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname = any($1) and c.relname <> $2 and {ext_c}
         union all
         select 'COLUMN ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname), col_description(c.oid, a.attnum)
         from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where c.relkind in ('r', 'p', 'v', 'm') and n.nspname = any($1) and c.relname <> $2 and {ext_c}
         union all
         select case p.prokind when 'p' then 'PROCEDURE ' else 'FUNCTION ' end || quote_ident(n.nspname) || '.' || quote_ident(p.proname)
                  || '(' || pg_get_function_identity_arguments(p.oid) || ')', obj_description(p.oid, 'pg_proc')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.prokind in ('f', 'p') and n.nspname = any($1) and {ext_p}
         union all
         select case t.typtype when 'd' then 'DOMAIN ' else 'TYPE ' end || quote_ident(n.nspname) || '.' || quote_ident(t.typname), obj_description(t.oid, 'pg_type')
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where t.typtype in ('e', 'd') and n.nspname = any($1) and {ext_t}",
        ext_c = not_ext("c.oid"), ext_p = not_ext("p.oid"), ext_t = not_ext("t.oid")), &p).await?;
    for r in rows {
        let object: String = r.get(0);
        if let Some(text) = r.get::<_, Option<String>>(1) {
            m.comments.insert(object.clone(), text);
        }
        m.objects.insert(object);
    }

    let rows = c.query(&format!(
        "select 'row-level security policies', count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)
         union all select 'tables with row-level security on', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relrowsecurity and n.nspname = any($1)
         union all select 'rules', count(*) from pg_rewrite r join pg_class c on c.oid = r.ev_class
           join pg_namespace n on n.oid = c.relnamespace where r.rulename <> '_RETURN' and n.nspname = any($1)
         union all select 'composite types', count(*) from pg_type t join pg_class c on c.oid = t.typrelid
           join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'c' and c.relkind = 'c' and n.nspname = any($1) and {ext_t}
         union all select 'range types', count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where t.typtype = 'r' and n.nspname = any($1) and {ext_t}
         union all select 'aggregates', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prokind = 'a' and n.nspname = any($1) and {ext_p}
         union all select 'operators', count(*) from pg_operator o join pg_namespace n on n.oid = o.oprnamespace
           where n.nspname = any($1) and {ext_o}
         union all select 'foreign tables', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'f' and n.nspname = any($1)
         union all select 'column-level privileges', count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace where a.attacl is not null and n.nspname = any($1)",
        ext_t = not_ext("t.oid"), ext_p = not_ext("p.oid"), ext_o = not_ext("o.oid")), &p1).await?;
    m.not_compared = rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1))).filter(|(_, n)| *n > 0).collect();
    Ok(m)
}

/// What either side has that the diff does not look at, for a visible warning.
pub fn not_compared(source: &Model, target: &Model, source_name: &str, target_name: &str) -> Vec<String> {
    let mut what: BTreeMap<&str, (i64, i64)> = BTreeMap::new();
    for (w, n) in &source.not_compared {
        what.entry(w).or_default().0 = *n;
    }
    for (w, n) in &target.not_compared {
        what.entry(w).or_default().1 = *n;
    }
    what.into_iter().map(|(w, (a, b))| format!("{w}: {a} in {source_name}, {b} in {target_name}")).collect()
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
    if let Some((parent, bound)) = &tb.partition_of {
        return format!("CREATE TABLE {t} PARTITION OF {} {bound};", qk(parent));
    }
    let body = tb.columns.iter().map(|c| format!("    {}", col_def(c))).collect::<Vec<_>>().join(",\n");
    match &tb.partition_by {
        Some(by) => format!("CREATE TABLE {t} (\n{body}\n) PARTITION BY {by};"),
        None => format!("CREATE TABLE {t} (\n{body}\n);"),
    }
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
    let mut s = format!("CREATE {}VIEW {} AS\n{};", if v.materialized { "MATERIALIZED " } else { "" }, qk(k), v.def);
    for d in v.indexes.values() {
        s.push_str(&format!("\n{d};"));
    }
    s
}

fn view_drop(k: &Key, v: &View) -> String {
    format!("DROP {}VIEW IF EXISTS {} CASCADE;", if v.materialized { "MATERIALIZED " } else { "" }, qk(k))
}

fn domain_ddl(k: &Key, d: &Domain) -> String {
    let mut s = format!("CREATE DOMAIN {} AS {}", qk(k), d.base);
    if let Some(def) = &d.default {
        s.push_str(&format!(" DEFAULT {def}"));
    }
    if d.not_null {
        s.push_str(" NOT NULL");
    }
    for (name, check) in &d.checks {
        s.push_str(&format!(" CONSTRAINT {} {check}", q(name)));
    }
    s + ";"
}

fn grant_sql(g: &Grant, revoke: bool) -> String {
    if revoke {
        format!("REVOKE {} ON {} FROM {};", g.privilege, g.object, g.grantee)
    } else {
        format!("GRANT {} ON {} TO {}{};", g.privilege, g.object, g.grantee, if g.grantable { " WITH GRANT OPTION" } else { "" })
    }
}

fn comment_sql(object: &str, text: Option<&String>) -> String {
    match text {
        Some(t) => format!("COMMENT ON {object} IS {};", lit(t)),
        None => format!("COMMENT ON {object} IS NULL;"),
    }
}

/// Grants are named `TABLE x` for views too; comments use `VIEW x`. Same object either way.
fn object_exists(m: &Model, object: &str) -> bool {
    if m.objects.contains(object) {
        return true;
    }
    object.strip_prefix("TABLE ").is_some_and(|rest| m.objects.contains(&format!("VIEW {rest}")) || m.objects.contains(&format!("MATERIALIZED VIEW {rest}")))
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

    for (name, schema) in &source.extensions {
        let ddl = format!("CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};", q(name), q(schema));
        match target.extensions.get(name) {
            None => out.push(change("extension", "Extensions", name, ChangeKind::Added, false, vec![step(P_TYPES, ddl.clone())], None, Some(ddl))),
            Some(old) if old == schema => {}
            Some(_) => {
                let steps = vec![step(P_TYPES, format!("ALTER EXTENSION {} SET SCHEMA {};", q(name), q(schema)))];
                out.push(change("extension", "Extensions", name, ChangeKind::Changed, false, steps, None, Some(ddl)));
            }
        }
    }
    for (name, schema) in target.extensions.iter().filter(|(n, _)| !source.extensions.contains_key(*n)) {
        let steps = vec![step(P_DROP_OTHER, format!("DROP EXTENSION IF EXISTS {};", q(name)))];
        let before = format!("CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};", q(name), q(schema));
        out.push(change("extension", "Extensions", name, ChangeKind::Removed, true, steps, Some(before), None));
    }

    for (k, d) in &source.domains {
        let name = format!("{}.{}", k.0, k.1);
        let dk = qk(k);
        match target.domains.get(k) {
            None => out.push(change("domain", "Domains", &name, ChangeKind::Added, false, vec![step(P_TYPES, domain_ddl(k, d))], None, Some(domain_ddl(k, d)))),
            Some(old) if old == d => {}
            Some(old) => {
                let mut steps = Vec::new();
                let mut destructive = false;
                if old.base != d.base {
                    destructive = true;
                    steps.push(step(P_TYPES, format!("-- {dk}: changing a domain's base type cannot be done in place; write it by hand.")));
                }
                if old.default != d.default {
                    steps.push(step(P_TYPES, match &d.default {
                        Some(v) => format!("ALTER DOMAIN {dk} SET DEFAULT {v};"),
                        None => format!("ALTER DOMAIN {dk} DROP DEFAULT;"),
                    }));
                }
                if old.not_null != d.not_null {
                    steps.push(step(P_TYPES, format!("ALTER DOMAIN {dk} {} NOT NULL;", if d.not_null { "SET" } else { "DROP" })));
                }
                for (cname, check) in &old.checks {
                    if d.checks.get(cname) != Some(check) {
                        steps.push(step(P_TYPES, format!("ALTER DOMAIN {dk} DROP CONSTRAINT {};", q(cname))));
                    }
                }
                for (cname, check) in &d.checks {
                    if old.checks.get(cname) != Some(check) {
                        steps.push(step(P_TYPES, format!("ALTER DOMAIN {dk} ADD CONSTRAINT {} {check};", q(cname))));
                    }
                }
                out.push(change("domain", "Domains", &name, ChangeKind::Changed, destructive, steps, Some(domain_ddl(k, old)), Some(domain_ddl(k, d))));
            }
        }
    }
    for (k, d) in target.domains.iter().filter(|(k, _)| !source.domains.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, format!("DROP DOMAIN {};", qk(k)))];
        out.push(change("domain", "Domains", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(domain_ddl(k, d)), None));
    }

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
            // Parents before their partitions.
            None => steps.push(Step { phase: P_TABLES, order: u32::from(new.partition_of.is_some()), sql: create_table(&t, new) }),
            Some(old) if old.partition_by != new.partition_by || old.partition_of != new.partition_of => {
                destructive = true;
                steps.push(step(P_TABLES, format!("-- {t}: partitioning changed; this needs a hand-written migration (new table, copy, swap).")));
            }
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
        // Partitions before their parent (dropping the parent would take them along).
        let order = if target.tables[k].partition_of.is_some() { 0 } else { 1 };
        let steps = vec![Step { phase: P_DROP_TABLES, order, sql: format!("DROP TABLE IF EXISTS {};", qk(k)) }];
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

    // Recreating a view also recreates what CASCADE took with it: its triggers, grants and comments.
    let create_view = |k: &Key| {
        let v = &source.views[k];
        let mut steps = vec![Step { phase: P_VIEWS, order: v.oid, sql: view_ddl(k, v) }];
        for ((s, t, _), def) in &source.triggers {
            if *s == k.0 && *t == k.1 {
                steps.push(step(P_TRIGGERS, def.clone()));
            }
        }
        let names = [format!("TABLE {}", qk(k)), format!("VIEW {}", qk(k)), format!("MATERIALIZED VIEW {}", qk(k))];
        for g in source.grants.iter().filter(|g| names.contains(&g.object)) {
            steps.push(step(P_GRANTS, grant_sql(g, false)));
        }
        for (obj, text) in source.comments.iter().filter(|(o, _)| names.contains(o) || o.starts_with(&format!("COLUMN {}.", qk(k)))) {
            steps.push(step(P_GRANTS, comment_sql(obj, Some(text))));
        }
        steps
    };
    let drop_view = |k: &Key, v: &View| step(P_DROP, view_drop(k, v));
    // Views this diff (re)creates; their triggers, grants and comments travel with them.
    let mut rebuilt: BTreeSet<Key> = BTreeSet::new();
    for (k, v) in &source.views {
        let name = format!("{}.{}", k.0, k.1);
        match target.views.get(k) {
            None => {
                rebuilt.insert(k.clone());
                out.push(change("view", "Views", &name, ChangeKind::Added, false, create_view(k), None, Some(view_ddl(k, v))));
            }
            Some(old) if old == v || (old.def == v.def && old.materialized == v.materialized && old.indexes == v.indexes) => {}
            Some(old) if old.def == v.def && old.materialized == v.materialized => {
                // Only a materialized view's indexes changed.
                let mut steps = Vec::new();
                for (iname, odef) in &old.indexes {
                    if v.indexes.get(iname) != Some(odef) {
                        steps.push(step(P_DROP, format!("DROP INDEX {}.{};", q(&k.0), q(iname))));
                    }
                }
                for (iname, def) in &v.indexes {
                    if old.indexes.get(iname) != Some(def) {
                        steps.push(step(P_KEYS, format!("{def};")));
                    }
                }
                out.push(change("view", "Views", &name, ChangeKind::Changed, false, steps, Some(view_ddl(k, old)), Some(view_ddl(k, v))));
            }
            Some(old) => {
                triggers.push((out.len(), k.clone()));
                rebuilt.insert(k.clone());
                let mut steps = vec![drop_view(k, old)];
                steps.extend(create_view(k));
                out.push(change("view", "Views", &name, ChangeKind::Changed, false, steps, Some(view_ddl(k, old)), Some(view_ddl(k, v))));
            }
        }
    }
    for (k, v) in target.views.iter().filter(|(k, _)| !source.views.contains_key(*k)) {
        triggers.push((out.len(), k.clone()));
        out.push(change("view", "Views", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, false, vec![drop_view(k, v)], Some(view_ddl(k, v)), None));
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
                rebuilt.insert(v.clone());
                out[i].steps.push(drop_view(&v, &target.views[&v]));
                out[i].steps.extend(create_view(&v));
                out[i].steps.sort_by_key(|s| (s.phase, s.order));
                out[i].sql = joined(&out[i].steps);
            }
        }
    }
    let views_rebuilt = rebuilt;

    for (key, def) in &source.triggers {
        let (s, t, name) = key;
        let on = format!("{}.{}", q(s), q(t));
        let label = format!("{s}.{t}.{name}");
        // A rebuilt view gets its triggers back with it.
        if views_rebuilt.contains(&(s.clone(), t.clone())) {
            continue;
        }
        match target.triggers.get(key) {
            None => out.push(change("trigger", "Triggers", &label, ChangeKind::Added, false, vec![step(P_TRIGGERS, def.clone())], None, Some(def.clone()))),
            Some(old) if old == def => {}
            Some(old) => {
                let steps = vec![step(P_DROP, format!("DROP TRIGGER IF EXISTS {} ON {on};", q(name))), step(P_TRIGGERS, def.clone())];
                out.push(change("trigger", "Triggers", &label, ChangeKind::Changed, false, steps, Some(old.clone()), Some(def.clone())));
            }
        }
    }
    for (key, def) in target.triggers.iter().filter(|(k, _)| !source.triggers.contains_key(*k)) {
        let (s, t, name) = key;
        // Dropping the table or view drops its triggers.
        if !source.tables.contains_key(&(s.clone(), t.clone())) && !source.views.contains_key(&(s.clone(), t.clone())) {
            continue;
        }
        let steps = vec![step(P_DROP, format!("DROP TRIGGER IF EXISTS {} ON {}.{};", q(name), q(s), q(t)))];
        out.push(change("trigger", "Triggers", &format!("{s}.{t}.{name}"), ChangeKind::Removed, false, steps, Some(def.clone()), None));
    }

    let is_rebuilt_view = |object: &str| {
        views_rebuilt.iter().any(|k| {
            let n = qk(k);
            object == format!("TABLE {n}") || object == format!("VIEW {n}") || object == format!("MATERIALIZED VIEW {n}") || object.starts_with(&format!("COLUMN {n}."))
        })
    };
    let mut grant_objects: BTreeSet<&String> = source.grants.iter().map(|g| &g.object).collect();
    grant_objects.extend(target.grants.iter().map(|g| &g.object));
    for object in grant_objects {
        if is_rebuilt_view(object) {
            continue;
        }
        let new: BTreeSet<&Grant> = source.grants.iter().filter(|g| &g.object == object).collect();
        let old: BTreeSet<&Grant> = target.grants.iter().filter(|g| &g.object == object).collect();
        if new == old {
            continue;
        }
        let mut steps: Vec<Step> = Vec::new();
        // Revokes only where the object stays; dropping it removes its grants.
        if object_exists(source, object) {
            steps.extend(old.difference(&new).map(|g| step(P_GRANTS, grant_sql(g, true))));
        }
        steps.extend(new.difference(&old).map(|g| step(P_GRANTS, grant_sql(g, false))));
        if steps.is_empty() {
            continue;
        }
        let show = |set: &BTreeSet<&Grant>| set.iter().map(|g| grant_sql(g, false)).collect::<Vec<_>>().join("\n");
        let before = (!old.is_empty()).then(|| show(&old));
        let after = (!new.is_empty()).then(|| show(&new));
        out.push(change("grant", "Grants", object, ChangeKind::Changed, false, steps, before, after));
    }

    let mut comment_objects: BTreeSet<&String> = source.comments.keys().collect();
    comment_objects.extend(target.comments.keys());
    for object in comment_objects {
        let (new, old) = (source.comments.get(object), target.comments.get(object));
        if new == old || is_rebuilt_view(object) || (new.is_none() && !object_exists(source, object)) {
            continue;
        }
        let steps = vec![step(P_GRANTS, comment_sql(object, new))];
        let kind = match (old, new) {
            (None, _) => ChangeKind::Added,
            (_, None) => ChangeKind::Removed,
            _ => ChangeKind::Changed,
        };
        out.push(change("comment", "Comments", object, kind, false, steps, old.map(|t| comment_sql(object, Some(t))), new.map(|t| comment_sql(object, Some(t)))));
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

#[derive(Debug, Serialize)]
pub struct ScratchCreated {
    pub environment: String,
    pub database: String,
}

/// Creates an empty database next to the dev database (`<dev db>_scratch`, same server and login)
/// and saves it as a private scratch environment. Refuses to touch a database that already exists.
pub async fn create_scratch(cfg: &Config, dev: Option<&str>, env_name: &str) -> Result<ScratchCreated> {
    let (dev_name, dev_env) = cfg.pick_role(dev, Role::Dev)?;
    if cfg.environments.contains_key(env_name) {
        return config(format!("an environment named '{env_name}' already exists"));
    }
    let c = db::connect(&dev_name, dev_env).await?;
    let dev_db: String = c.query_one("select current_database()::text", &[]).await?.get(0);
    let database = format!("{dev_db}_scratch");
    let exists: bool = c.query_one("select exists (select 1 from pg_database where datname = $1)", &[&database]).await?.get(0);
    if exists {
        return config(format!(
            "a database named {database} already exists on {dev_name}'s server; if it may be erased, add it as the scratch environment yourself"
        ));
    }
    c.batch_execute(&format!("CREATE DATABASE {}", q(&database))).await.map_err(|e| match e.as_db_error() {
        Some(d) if d.code() == &tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE => crate::Error::Config(format!(
            "{dev_name}'s login may not create databases (it needs CREATEDB); ask an admin to create {database}, then add it as the scratch environment"
        )),
        _ => e.into(),
    })?;
    let env = crate::config::Environment {
        url: db::with_database(&dev_env.url, &database),
        user: dev_env.user.clone(),
        password: dev_env.password.clone(),
        role: Role::Scratch,
        allow_clean: true,
    };
    crate::config::save_environment(&cfg.root, env_name, &env, false)?;
    Ok(ScratchCreated { environment: env_name.to_string(), database })
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

#[derive(Debug, Serialize)]
pub struct Comparison {
    pub changes: Vec<Change>,
    /// objects that exist but are not compared, e.g. "rules: 2 in dev, 0 in the scripts"
    pub not_compared: Vec<String>,
}

/// Rebuilds the scratch database from the project's migrations, then diffs dev against it.
pub async fn dev_vs_migrations(cfg: &Config, dev: Option<&str>, scratch: Option<&str>, log: Log<'_>) -> Result<Comparison> {
    let (dev_name, dev_env) = cfg.pick_role(dev, Role::Dev)?;
    let (scratch_name, scratch_env) = scratch_env(cfg, scratch)?;
    if dev_name == scratch_name {
        return config("the dev and scratch environments must be different databases");
    }
    let s = rebuild_scratch(cfg, &scratch_name, scratch_env, None, log).await?;
    log(Level::Info, &format!("Comparing '{dev_name}' with the migrations"));
    let d = db::connect(&dev_name, dev_env).await?;
    let (source, target) = (model_of(cfg, &d).await?, model_of(cfg, &s).await?);
    let changes = diff(&source, &target);
    let not_compared = not_compared(&source, &target, &dev_name, "the scripts");
    log(Level::Info, &format!("{} difference(s)", changes.len()));
    for n in &not_compared {
        log(Level::Warn, &format!("not compared: {n}"));
    }
    Ok(Comparison { changes, not_compared })
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

/// The whole schema of an existing database as one script (F07). As the next V script by default,
/// then `baseline` that database at its version so it never runs there. With `as_baseline`, as a
/// B script that empty databases start from: versioned at the database's latest applied version
/// (the state it describes), or the next version when the database has no history.
pub async fn capture(cfg: &Config, env_name: Option<&str>, description: &str, as_baseline: bool) -> Result<Generated> {
    let (name, env) = cfg.pick(env_name)?;
    let c = db::connect(&name, env).await?;
    let model = model_of(cfg, &c).await?;
    let changes = compare(&model, &Model::default());
    if changes.is_empty() {
        return config(format!("'{name}' has nothing in {} to capture", cfg.project.schemas.join(", ")));
    }
    let mut g = generate(cfg, &changes, description, false)?;
    if as_baseline {
        let applied = runner::info(cfg, Some(&name))
            .await?
            .into_iter()
            .filter(|i| matches!(i.state, runner::State::Applied | runner::State::Baseline))
            .filter_map(|i| i.version)
            .max_by_key(|v| migration::Version::parse(v));
        if let Some(v) = applied {
            g.version = v;
        }
        let slug = check_description(description)?.replace([' ', '-'], "_");
        g.file_name = format!("B{}__{slug}.sql", g.version);
    }
    Ok(g)
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
        assert_eq!(customer.undo_steps[0].sql, "DROP TABLE IF EXISTS public.customer;");
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
        let v = |oid, def: &str| View { oid, def: def.into(), materialized: false, indexes: BTreeMap::new() };
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
