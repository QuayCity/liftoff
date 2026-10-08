//! SQL Server schema diff: reads a database's schema from sys.* and turns differences into T-SQL
//! steps, in the same `Change` / phase shape as the PostgreSQL diff, so generate, undo, capture,
//! squash and the drift checks work the same way.
//! Objects: tables (columns, identity, computed columns, defaults), primary keys, unique, check and
//! foreign keys, rowstore indexes, views, procedures, functions, triggers, sequences, alias types.
//! Counted as "not compared": synonyms, table types, CLR objects, encrypted modules, columnstore /
//! XML / spatial indexes, indexes on views, permissions, extended properties, column collations.
//! Every statement ends with GO: CREATE VIEW / PROCEDURE / FUNCTION / TRIGGER must start a batch.

use crate::diff::{change, step, Change, ChangeKind, Step, P_DROP, P_DROP_OTHER, P_DROP_TABLES, P_FKS, P_FUNCS, P_KEYS, P_TABLES, P_TRIGGERS, P_TYPES, P_VIEWS};
use crate::error::Result;
use crate::mssql::{quote, Db};
use std::collections::{BTreeMap, BTreeSet};

type Key = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    /// `IDENTITY(1,1)`
    pub identity: Option<String>,
    /// `AS ([qty]*[price]) PERSISTED`
    pub computed: Option<String>,
    /// default constraint name, when it was named explicitly
    pub default_name: Option<String>,
    /// `((0))`, as SQL Server stores it
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsConstraint {
    pub name: String,
    /// SQL Server picked the name (PK__orders__3213E83F…); it differs per database, so these are
    /// matched by definition instead.
    pub system_named: bool,
    /// `PRIMARY KEY CLUSTERED ([id] ASC)`, `CHECK ([total]>=(0))`, `FOREIGN KEY ([c]) REFERENCES …`
    pub def: String,
    /// PK, UQ, C, F
    pub kind: String,
    /// key or foreign key columns, `a,b`, to find an unnamed constraint again
    pub cols: String,
}

impl MsConstraint {
    fn key(&self) -> String {
        if self.system_named { format!("~{}", self.def) } else { self.name.clone() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MsTable {
    pub columns: Vec<MsColumn>,
    pub constraints: Vec<MsConstraint>,
    /// index name -> CREATE INDEX statement (indexes behind a key constraint are left out)
    pub indexes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleKind {
    View,
    Procedure,
    Function,
    Trigger,
}

impl ModuleKind {
    fn word(self) -> &'static str {
        match self {
            ModuleKind::View => "VIEW",
            ModuleKind::Procedure => "PROCEDURE",
            ModuleKind::Function => "FUNCTION",
            ModuleKind::Trigger => "TRIGGER",
        }
    }
    fn group(self) -> &'static str {
        match self {
            ModuleKind::View => "Views",
            ModuleKind::Procedure => "Procedures",
            ModuleKind::Function => "Functions",
            ModuleKind::Trigger => "Triggers",
        }
    }
    fn filter_kind(self) -> &'static str {
        match self {
            ModuleKind::View => "view",
            ModuleKind::Procedure | ModuleKind::Function => "function",
            ModuleKind::Trigger => "trigger",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Module {
    pub kind: ModuleKind,
    /// the CREATE statement as written, line endings and trailing spaces normalised
    pub def: String,
    /// creation order in the source database; created in this order
    pub order: u32,
    /// triggers: the table they belong to
    pub parent: Option<Key>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsSequence {
    pub data_type: String,
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cycle: bool,
    /// None: NO CACHE; Some(None): CACHE with the default size
    pub cache: Option<Option<i32>>,
}

#[derive(Debug, Clone, Default)]
pub struct MsModel {
    pub tables: BTreeMap<Key, MsTable>,
    pub modules: BTreeMap<Key, Module>,
    pub sequences: BTreeMap<Key, MsSequence>,
    /// alias types: (schema, name) -> `CREATE TYPE … FROM …`
    pub types: BTreeMap<Key, String>,
    pub not_compared: Vec<(String, i64)>,
}

/* ---------- reading the schema ---------- */

fn lit(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

fn qk(k: &Key) -> String {
    format!("{}.{}", quote(&k.0), quote(&k.1))
}

/// A column or alias type's type as written in DDL.
pub fn type_name(name: &str, user_defined: bool, schema: &str, max_len: i16, precision: u8, scale: u8) -> String {
    if user_defined {
        return format!("{}.{}", quote(schema), quote(name));
    }
    let len = |n: i16| if n == -1 { "max".to_string() } else { n.to_string() };
    match name {
        "varchar" | "char" | "varbinary" | "binary" => format!("{name}({})", len(max_len)),
        "nvarchar" | "nchar" => format!("{name}({})", if max_len == -1 { "max".into() } else { (max_len / 2).to_string() }),
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{name}({scale})"),
        "float" if precision != 53 => format!("float({precision})"),
        _ => name.to_string(),
    }
}

/// Line endings, trailing spaces and `CREATE` vs `CREATE OR ALTER` do not count as a change in a
/// module's text (SQL Server stores `CREATE OR ALTER VIEW` as `CREATE   VIEW`).
fn normalize(def: &str) -> String {
    let t = def.replace("\r\n", "\n").lines().map(str::trim_end).collect::<Vec<_>>().join("\n").trim().to_string();
    match create_header(&t) {
        Some((i, j)) => format!("{}CREATE {}", &t[..i], &t[j..]),
        None => t,
    }
}

pub async fn introspect(c: &Db, schemas: &[String], exclude_table: &str) -> Result<MsModel> {
    let names = schemas.iter().map(|s| lit(s)).collect::<Vec<_>>().join(", ");
    let in_scope = format!("SELECT t.object_id FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name IN ({names}) AND t.is_ms_shipped = 0 AND t.name <> {}", lit(exclude_table));
    let mut m = MsModel::default();
    let text = |r: &tiberius::Row, i: usize| r.get::<&str, _>(i).unwrap_or_default().to_string();

    let mut by_id: BTreeMap<i32, Key> = BTreeMap::new();
    for r in c.query(&format!("SELECT t.object_id, SCHEMA_NAME(t.schema_id), t.name FROM sys.tables t WHERE t.object_id IN ({in_scope})"), &[]).await? {
        let k = (text(&r, 1), text(&r, 2));
        by_id.insert(r.get(0).unwrap_or_default(), k.clone());
        m.tables.insert(k, MsTable::default());
    }

    for r in c
        .query(
            &format!(
                "SELECT c.object_id, c.name, ty.name, ty.is_user_defined, SCHEMA_NAME(ty.schema_id), c.max_length, c.precision, c.scale,
                        c.is_nullable, CONVERT(nvarchar(40), ic.seed_value), CONVERT(nvarchar(40), ic.increment_value),
                        cc.definition, cc.is_persisted, d.name, d.is_system_named, d.definition
                 FROM sys.columns c
                 JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                 LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                 LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
                 LEFT JOIN sys.default_constraints d ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id
                 WHERE c.object_id IN ({in_scope})
                 ORDER BY c.object_id, c.column_id"
            ),
            &[],
        )
        .await?
    {
        let Some(k) = by_id.get(&r.get::<i32, _>(0).unwrap_or_default()) else { continue };
        let computed = r.get::<&str, _>(11).map(|d| format!("AS {d}{}", if r.get::<bool, _>(12).unwrap_or(false) { " PERSISTED" } else { "" }));
        let identity = r.get::<&str, _>(9).map(|seed| format!("IDENTITY({seed},{})", text(&r, 10)));
        let col = MsColumn {
            name: text(&r, 1),
            data_type: type_name(&text(&r, 2), r.get(3).unwrap_or(false), &text(&r, 4), r.get(5).unwrap_or(0), r.get(6).unwrap_or(0), r.get(7).unwrap_or(0)),
            not_null: !r.get::<bool, _>(8).unwrap_or(true),
            identity,
            computed,
            default_name: r.get::<&str, _>(13).filter(|_| !r.get::<bool, _>(14).unwrap_or(true)).map(String::from),
            default: r.get::<&str, _>(15).map(String::from),
        };
        m.tables.get_mut(k).unwrap().columns.push(col);
    }

    let cols = |side: &str| {
        format!(
            "(SELECT STRING_AGG(c.name COLLATE DATABASE_DEFAULT, ',') WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM sys.foreign_key_columns fc
              JOIN sys.columns c ON c.object_id = fc.{side}_object_id AND c.column_id = fc.{side}_column_id WHERE fc.constraint_object_id = f.object_id)"
        )
    };
    let quoted = |side: &str| {
        format!(
            "(SELECT STRING_AGG(QUOTENAME(c.name) COLLATE DATABASE_DEFAULT, N', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM sys.foreign_key_columns fc
              JOIN sys.columns c ON c.object_id = fc.{side}_object_id AND c.column_id = fc.{side}_column_id WHERE fc.constraint_object_id = f.object_id)"
        )
    };
    let key_cols = |agg: &str, sep: &str| {
        format!(
            "(SELECT STRING_AGG(({agg}) COLLATE DATABASE_DEFAULT, {sep}) WITHIN GROUP (ORDER BY ic.key_ordinal) FROM sys.index_columns ic
              JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0)"
        )
    };
    let sql = format!(
        "SELECT kc.parent_object_id, kc.name, kc.is_system_named, RTRIM(kc.type),
                CASE kc.type WHEN 'PK' THEN N'PRIMARY KEY ' ELSE N'UNIQUE ' END + i.type_desc COLLATE DATABASE_DEFAULT + N' (' + {kq} + N')', {kn}
         FROM sys.key_constraints kc JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
         WHERE kc.parent_object_id IN ({in_scope})
         UNION ALL
         SELECT cc.parent_object_id, cc.name, cc.is_system_named, 'C', N'CHECK ' + cc.definition COLLATE DATABASE_DEFAULT, N''
         FROM sys.check_constraints cc WHERE cc.parent_object_id IN ({in_scope})
         UNION ALL
         SELECT f.parent_object_id, f.name, f.is_system_named, 'F',
                N'FOREIGN KEY (' + {pq} + N') REFERENCES ' + QUOTENAME(OBJECT_SCHEMA_NAME(f.referenced_object_id)) COLLATE DATABASE_DEFAULT + N'.'
                + QUOTENAME(OBJECT_NAME(f.referenced_object_id)) COLLATE DATABASE_DEFAULT + N' (' + {rq} + N')'
                + CASE f.delete_referential_action WHEN 1 THEN N' ON DELETE CASCADE' WHEN 2 THEN N' ON DELETE SET NULL' WHEN 3 THEN N' ON DELETE SET DEFAULT' ELSE N'' END
                + CASE f.update_referential_action WHEN 1 THEN N' ON UPDATE CASCADE' WHEN 2 THEN N' ON UPDATE SET NULL' WHEN 3 THEN N' ON UPDATE SET DEFAULT' ELSE N'' END,
                {pc}
         FROM sys.foreign_keys f WHERE f.parent_object_id IN ({in_scope})",
        kq = key_cols("QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END", "N', '"),
        kn = key_cols("c.name", "','"),
        pq = quoted("parent"),
        rq = quoted("referenced"),
        pc = cols("parent"),
    );
    for r in c.query(&sql, &[]).await? {
        let Some(k) = by_id.get(&r.get::<i32, _>(0).unwrap_or_default()) else { continue };
        m.tables.get_mut(k).unwrap().constraints.push(MsConstraint {
            name: text(&r, 1),
            system_named: r.get(2).unwrap_or(false),
            kind: text(&r, 3),
            def: text(&r, 4),
            cols: text(&r, 5),
        });
    }
    for t in m.tables.values_mut() {
        t.constraints.sort_by_key(MsConstraint::key);
    }

    let sql = format!(
        "SELECT i.object_id, i.name,
                N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END + i.type_desc COLLATE DATABASE_DEFAULT + N' INDEX ' + QUOTENAME(i.name) COLLATE DATABASE_DEFAULT
                + N' ON ' + QUOTENAME(OBJECT_SCHEMA_NAME(i.object_id)) COLLATE DATABASE_DEFAULT + N'.' + QUOTENAME(OBJECT_NAME(i.object_id)) COLLATE DATABASE_DEFAULT + N' (' + {keys} + N')'
                + ISNULL(N' INCLUDE (' + (SELECT STRING_AGG(QUOTENAME(c.name) COLLATE DATABASE_DEFAULT, N', ') WITHIN GROUP (ORDER BY ic.index_column_id) FROM sys.index_columns ic
                     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                     WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1) + N')', N'')
                + CASE WHEN i.has_filter = 1 THEN N' WHERE ' + i.filter_definition COLLATE DATABASE_DEFAULT ELSE N'' END
         FROM sys.indexes i
         WHERE i.object_id IN ({in_scope}) AND i.type IN (1, 2) AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0",
        keys = key_cols("QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END", "N', '"),
    );
    for r in c.query(&sql, &[]).await? {
        let Some(k) = by_id.get(&r.get::<i32, _>(0).unwrap_or_default()) else { continue };
        m.tables.get_mut(k).unwrap().indexes.insert(text(&r, 1), text(&r, 2));
    }

    for (i, r) in c
        .query(
            &format!(
                "SELECT s.name, o.name, RTRIM(o.type), m.definition, OBJECT_SCHEMA_NAME(o.parent_object_id), OBJECT_NAME(o.parent_object_id)
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.sql_modules m ON m.object_id = o.object_id
                 WHERE s.name IN ({names}) AND o.is_ms_shipped = 0 AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR') AND m.definition IS NOT NULL
                   AND (o.type <> 'TR' OR o.parent_object_id IN ({in_scope}))
                 ORDER BY o.create_date, o.object_id"
            ),
            &[],
        )
        .await?
        .iter()
        .enumerate()
    {
        let kind = match text(r, 2).as_str() {
            "V" => ModuleKind::View,
            "P" => ModuleKind::Procedure,
            "TR" => ModuleKind::Trigger,
            _ => ModuleKind::Function,
        };
        let parent = (kind == ModuleKind::Trigger).then(|| (text(r, 4), text(r, 5)));
        m.modules.insert((text(r, 0), text(r, 1)), Module { kind, def: normalize(&text(r, 3)), order: i as u32, parent });
    }

    for r in c
        .query(
            &format!(
                "SELECT SCHEMA_NAME(q.schema_id), q.name, TYPE_NAME(q.user_type_id), CONVERT(nvarchar(40), q.start_value), CONVERT(nvarchar(40), q.increment),
                        CONVERT(nvarchar(40), q.minimum_value), CONVERT(nvarchar(40), q.maximum_value), q.is_cycling, q.is_cached, q.cache_size
                 FROM sys.sequences q WHERE SCHEMA_NAME(q.schema_id) IN ({names})"
            ),
            &[],
        )
        .await?
    {
        m.sequences.insert((text(&r, 0), text(&r, 1)), MsSequence {
            data_type: text(&r, 2),
            start: text(&r, 3),
            increment: text(&r, 4),
            min: text(&r, 5),
            max: text(&r, 6),
            cycle: r.get(7).unwrap_or(false),
            cache: r.get::<bool, _>(8).unwrap_or(true).then(|| r.get::<i32, _>(9)),
        });
    }

    for r in c
        .query(
            &format!(
                "SELECT SCHEMA_NAME(t.schema_id), t.name, bt.name, t.max_length, t.precision, t.scale, t.is_nullable
                 FROM sys.types t JOIN sys.types bt ON bt.user_type_id = t.system_type_id
                 WHERE t.is_user_defined = 1 AND t.is_table_type = 0 AND t.is_assembly_type = 0 AND SCHEMA_NAME(t.schema_id) IN ({names})"
            ),
            &[],
        )
        .await?
    {
        let k = (text(&r, 0), text(&r, 1));
        let base = type_name(&text(&r, 2), false, "", r.get(3).unwrap_or(0), r.get(4).unwrap_or(0), r.get(5).unwrap_or(0));
        let ddl = format!("CREATE TYPE {} FROM {base}{};", qk(&k), if r.get::<bool, _>(6).unwrap_or(true) { "" } else { " NOT NULL" });
        m.types.insert(k, ddl);
    }

    let objects_in = format!("SELECT o.object_id FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name IN ({names}) AND o.is_ms_shipped = 0");
    for r in c
        .query(
            &format!(
                "SELECT N'synonyms', COUNT(*) FROM sys.synonyms WHERE object_id IN ({objects_in})
                 UNION ALL SELECT N'table types', COUNT(*) FROM sys.table_types WHERE SCHEMA_NAME(schema_id) IN ({names})
                 UNION ALL SELECT N'CLR objects', COUNT(*) FROM sys.objects WHERE object_id IN ({objects_in}) AND type IN ('PC', 'FS', 'FT', 'TA', 'AF')
                 UNION ALL SELECT N'encrypted modules', COUNT(*) FROM sys.sql_modules WHERE object_id IN ({objects_in}) AND definition IS NULL
                 UNION ALL SELECT N'columnstore, XML and spatial indexes', COUNT(*) FROM sys.indexes WHERE object_id IN ({in_scope}) AND type NOT IN (0, 1, 2)
                 UNION ALL SELECT N'indexes on views', COUNT(*) FROM sys.indexes i JOIN sys.views v ON v.object_id = i.object_id WHERE v.object_id IN ({objects_in}) AND i.type > 0
                 UNION ALL SELECT N'permissions', COUNT(*) FROM sys.database_permissions WHERE class = 1 AND major_id IN ({objects_in})
                 UNION ALL SELECT N'extended properties', COUNT(*) FROM sys.extended_properties WHERE class = 1 AND major_id IN ({objects_in})
                 UNION ALL SELECT N'column collations other than the database default', COUNT(*) FROM sys.columns
                   WHERE object_id IN ({in_scope}) AND collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname)"
            ),
            &[],
        )
        .await?
    {
        let n = i64::from(r.get::<i32, _>(1).unwrap_or(0));
        if n > 0 {
            m.not_compared.push((text(&r, 0), n));
        }
    }
    Ok(m)
}

/// Removes what the project's comparison filters exclude; a table takes its triggers along.
pub fn apply_filters(m: &mut MsModel, p: &crate::config::Project) {
    if p.filters.is_empty() {
        return;
    }
    m.tables.retain(|k, _| p.compares("table", &k.0, &k.1));
    let tables: BTreeSet<Key> = m.tables.keys().cloned().collect();
    m.modules.retain(|k, md| p.compares(md.kind.filter_kind(), &k.0, &k.1) && md.parent.as_ref().is_none_or(|t| tables.contains(t)));
    m.sequences.retain(|k, _| p.compares("sequence", &k.0, &k.1));
    m.types.retain(|k, _| p.compares("type", &k.0, &k.1));
}

/* ---------- DDL ---------- */

fn go(sql: impl AsRef<str>) -> String {
    format!("{}\nGO", sql.as_ref().trim_end())
}

fn col_def(c: &MsColumn) -> String {
    let n = quote(&c.name);
    if let Some(comp) = &c.computed {
        return format!("{n} {comp}");
    }
    let mut s = format!("{n} {}", c.data_type);
    if let Some(i) = &c.identity {
        s.push_str(&format!(" {i}"));
    }
    s.push_str(if c.not_null { " NOT NULL" } else { " NULL" });
    if let Some(d) = &c.default {
        if let Some(name) = &c.default_name {
            s.push_str(&format!(" CONSTRAINT {}", quote(name)));
        }
        s.push_str(&format!(" DEFAULT {d}"));
    }
    s
}

fn add_constraint(t: &str, c: &MsConstraint) -> String {
    if c.system_named { go(format!("ALTER TABLE {t} ADD {};", c.def)) } else { go(format!("ALTER TABLE {t} ADD CONSTRAINT {} {};", quote(&c.name), c.def)) }
}

/// Drops a constraint whose name is only known in the database it runs on.
fn drop_found(t: &str, lookup: &str) -> String {
    go(format!(
        "DECLARE @name sysname = ({lookup});\nIF @name IS NOT NULL\nBEGIN\n    DECLARE @sql nvarchar(max) = N'ALTER TABLE {} DROP CONSTRAINT ' + QUOTENAME(@name);\n    EXEC (@sql);\nEND",
        t.replace('\'', "''")
    ))
}

fn drop_constraint(t: &str, c: &MsConstraint) -> String {
    if !c.system_named {
        return go(format!("ALTER TABLE {t} DROP CONSTRAINT {};", quote(&c.name)));
    }
    let on = format!("parent_object_id = OBJECT_ID({})", lit(t));
    let lookup = match c.kind.as_str() {
        "PK" => format!("SELECT name FROM sys.key_constraints WHERE {on} AND type = 'PK'"),
        "C" => format!("SELECT name FROM sys.check_constraints WHERE {on} AND N'CHECK ' + definition = {}", lit(&c.def)),
        "UQ" => format!(
            "SELECT kc.name FROM sys.key_constraints kc WHERE kc.{on} AND kc.type = 'UQ' AND (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) \
             FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id AND ic.key_ordinal > 0) = {}",
            lit(&c.cols)
        ),
        _ => format!(
            "SELECT f.name FROM sys.foreign_keys f WHERE f.{on} AND (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY fc.constraint_column_id) \
             FROM sys.foreign_key_columns fc JOIN sys.columns c ON c.object_id = fc.parent_object_id AND c.column_id = fc.parent_column_id \
             WHERE fc.constraint_object_id = f.object_id) = {}",
            lit(&c.cols)
        ),
    };
    drop_found(t, &lookup)
}

fn drop_default(t: &str, c: &MsColumn) -> String {
    match &c.default_name {
        Some(n) => go(format!("ALTER TABLE {t} DROP CONSTRAINT {};", quote(n))),
        None => drop_found(
            t,
            &format!(
                "SELECT d.name FROM sys.default_constraints d JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id \
                 WHERE d.parent_object_id = OBJECT_ID({}) AND c.name = {}",
                lit(t),
                lit(&c.name)
            ),
        ),
    }
}

fn add_default(t: &str, c: &MsColumn) -> Option<String> {
    let d = c.default.as_ref()?;
    let name = c.default_name.as_ref().map(|n| format!("CONSTRAINT {} ", quote(n))).unwrap_or_default();
    Some(go(format!("ALTER TABLE {t} ADD {name}DEFAULT {d} FOR {};", quote(&c.name))))
}

fn create_table(t: &str, tb: &MsTable) -> String {
    let body = tb.columns.iter().map(|c| format!("    {}", col_def(c))).collect::<Vec<_>>().join(",\n");
    go(format!("CREATE TABLE {t} (\n{body}\n);"))
}

/// The whole table as one readable block, for the side-by-side view and the schema model.
pub fn table_ddl(k: &Key, tb: &MsTable) -> String {
    let t = qk(k);
    let mut out = vec![create_table(&t, tb)];
    out.extend(tb.constraints.iter().map(|c| add_constraint(&t, c)));
    out.extend(tb.indexes.values().map(|d| go(format!("{d};"))));
    out.join("\n")
}

/// Where the leading `CREATE` starts (after comments) and where the word after
/// `CREATE [OR ALTER]` starts.
fn create_header(def: &str) -> Option<(usize, usize)> {
    let b = def.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
        } else if def[i..].starts_with("--") {
            i = def[i..].find('\n').map_or(b.len(), |n| i + n);
        } else if def[i..].starts_with("/*") {
            i = def[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
        } else {
            break;
        }
    }
    let word = |at: usize, w: &str| def.get(at..at + w.len()).is_some_and(|s| s.eq_ignore_ascii_case(w));
    let skip_ws = |at: usize| at + def[at..].len() - def[at..].trim_start().len();
    if !word(i, "create") {
        return None;
    }
    let mut j = skip_ws(i + 6);
    if word(j, "or") {
        let k = skip_ws(j + 2);
        if word(k, "alter") {
            j = skip_ws(k + 5);
        }
    }
    Some((i, j))
}

/// `CREATE VIEW …` -> `CREATE OR ALTER VIEW …`, so objects that depend on it keep working.
fn create_or_alter(def: &str) -> String {
    match create_header(def) {
        Some((i, j)) => format!("{}CREATE OR ALTER {}", &def[..i], &def[j..]),
        None => def.to_string(),
    }
}

fn sequence_ddl(k: &Key, s: &MsSequence) -> String {
    go(format!("CREATE SEQUENCE {} AS {} START WITH {} {};", qk(k), s.data_type, s.start, sequence_clauses(s)))
}

fn sequence_clauses(s: &MsSequence) -> String {
    let cache = match s.cache {
        None => "NO CACHE".to_string(),
        Some(None) => "CACHE".to_string(),
        Some(Some(n)) => format!("CACHE {n}"),
    };
    format!("INCREMENT BY {} MINVALUE {} MAXVALUE {} {} {cache}", s.increment, s.min, s.max, if s.cycle { "CYCLE" } else { "NO CYCLE" })
}

fn module_phase(m: &Module) -> Step {
    let (phase, order) = match m.kind {
        ModuleKind::Function => (P_FUNCS, m.order),
        ModuleKind::View => (P_VIEWS, m.order),
        ModuleKind::Procedure => (P_TRIGGERS, m.order),
        ModuleKind::Trigger => (P_TRIGGERS, 1_000_000 + m.order),
    };
    Step { phase, order, sql: String::new() }
}

/* ---------- compare ---------- */

/// Changes that turn `target` into `source`, each with the reverse steps for an undo script.
pub fn diff(source: &MsModel, target: &MsModel) -> Vec<Change> {
    let mut forward = compare(source, target);
    let backward = compare(target, source);
    for c in &mut forward {
        if let Some(b) = backward.iter().find(|b| b.id == c.id) {
            c.undo_steps = b.steps.clone();
        }
    }
    forward
}

pub fn compare(source: &MsModel, target: &MsModel) -> Vec<Change> {
    let mut out = Vec::new();

    for (k, ddl) in &source.types {
        let name = format!("{}.{}", k.0, k.1);
        match target.types.get(k) {
            None => out.push(change("type", "Types", &name, ChangeKind::Added, false, vec![step(P_TYPES, go(ddl))], None, Some(ddl.clone()))),
            Some(old) if old == ddl => {}
            Some(old) => {
                let steps = vec![step(P_TYPES, format!("-- {}: an alias type cannot be altered while columns use it; write this change by hand.", qk(k)))];
                out.push(change("type", "Types", &name, ChangeKind::Changed, true, steps, Some(old.clone()), Some(ddl.clone())));
            }
        }
    }
    for (k, ddl) in target.types.iter().filter(|(k, _)| !source.types.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, go(format!("DROP TYPE IF EXISTS {};", qk(k))))];
        out.push(change("type", "Types", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(ddl.clone()), None));
    }

    for (k, s) in &source.sequences {
        let name = format!("{}.{}", k.0, k.1);
        match target.sequences.get(k) {
            None => out.push(change("sequence", "Sequences", &name, ChangeKind::Added, false, vec![step(P_TYPES, sequence_ddl(k, s))], None, Some(sequence_ddl(k, s)))),
            Some(old) if old == s => {}
            Some(old) => {
                let mut steps = Vec::new();
                if old.data_type != s.data_type {
                    steps.push(step(P_TYPES, format!("-- {}: a sequence's type cannot be altered; drop and recreate it by hand.", qk(k))));
                }
                steps.push(step(P_TYPES, go(format!("ALTER SEQUENCE {} {};", qk(k), sequence_clauses(s)))));
                out.push(change("sequence", "Sequences", &name, ChangeKind::Changed, old.data_type != s.data_type, steps, Some(sequence_ddl(k, old)), Some(sequence_ddl(k, s))));
            }
        }
    }
    for (k, s) in target.sequences.iter().filter(|(k, _)| !source.sequences.contains_key(*k)) {
        let steps = vec![step(P_DROP_OTHER, go(format!("DROP SEQUENCE IF EXISTS {};", qk(k))))];
        out.push(change("sequence", "Sequences", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(sequence_ddl(k, s)), None));
    }

    for (k, new) in &source.tables {
        let name = format!("{}.{}", k.0, k.1);
        let t = qk(k);
        let old = target.tables.get(k);
        let mut steps = Vec::new();
        let mut destructive = false;
        match old {
            None => steps.push(step(P_TABLES, create_table(&t, new))),
            Some(old) => {
                for c in &new.columns {
                    match old.columns.iter().find(|o| o.name == c.name) {
                        None => steps.push(step(P_TABLES, go(format!("ALTER TABLE {t} ADD {};", col_def(c))))),
                        Some(o) if o == c => {}
                        Some(o) => destructive |= alter_column(&t, o, c, &mut steps),
                    }
                }
                for o in old.columns.iter().filter(|o| !new.columns.iter().any(|c| c.name == o.name)) {
                    destructive = true;
                    if o.default.is_some() {
                        // SQL Server refuses to drop a column that still has a default.
                        steps.push(step(P_DROP, drop_default(&t, o)));
                    }
                    steps.push(step(P_TABLES, go(format!("ALTER TABLE {t} DROP COLUMN {};", quote(&o.name)))));
                }
            }
        }
        let empty = MsTable::default();
        let old_t = old.unwrap_or(&empty);
        // SQL Server refuses ALTER COLUMN while an index or key uses the column: those are
        // dropped before and recreated after.
        let retyped: Vec<String> = new
            .columns
            .iter()
            .filter(|c| {
                old_t.columns.iter().any(|o| {
                    o.name == c.name && o.computed.is_none() && c.computed.is_none() && o.identity == c.identity && (o.data_type != c.data_type || o.not_null != c.not_null)
                })
            })
            .map(|c| quote(&c.name))
            .collect();
        let rebuild = |def: &str| retyped.iter().any(|c| def.contains(c.as_str()));
        let same = |a: &MsConstraint, b: &MsConstraint| a.key() == b.key() && a.def == b.def && !rebuild(&a.def);
        for o in &old_t.constraints {
            if !new.constraints.iter().any(|c| same(c, o)) {
                // Foreign keys go first: a key they point at cannot be dropped before them.
                steps.push(Step { phase: P_DROP, order: u32::from(o.kind != "F"), sql: drop_constraint(&t, o) });
            }
        }
        for c in &new.constraints {
            if !old_t.constraints.iter().any(|o| same(o, c)) {
                steps.push(step(if c.kind == "F" { P_FKS } else { P_KEYS }, add_constraint(&t, c)));
            }
        }
        for (iname, odef) in &old_t.indexes {
            if new.indexes.get(iname) != Some(odef) || rebuild(odef) {
                steps.push(step(P_DROP, go(format!("DROP INDEX {} ON {t};", quote(iname)))));
            }
        }
        for (iname, def) in &new.indexes {
            if old_t.indexes.get(iname) != Some(def) || rebuild(def) {
                steps.push(step(P_KEYS, go(format!("{def};"))));
            }
        }
        if !steps.is_empty() {
            let kind = if old.is_none() { ChangeKind::Added } else { ChangeKind::Changed };
            out.push(change("table", "Tables", &name, kind, destructive, steps, old.map(|o| table_ddl(k, o)), Some(table_ddl(k, new))));
        }
    }
    for (k, old) in target.tables.iter().filter(|(k, _)| !source.tables.contains_key(*k)) {
        let t = qk(k);
        // Foreign keys from other tables pointing here have to go first.
        let mut steps = vec![step(P_DROP_TABLES, go(format!("DROP TABLE IF EXISTS {t};")))];
        for c in old.constraints.iter().filter(|c| c.kind == "F") {
            steps.push(Step { phase: P_DROP, order: 0, sql: drop_constraint(&t, c) });
        }
        out.push(change("table", "Tables", &format!("{}.{}", k.0, k.1), ChangeKind::Removed, true, steps, Some(table_ddl(k, old)), None));
    }

    for (k, m) in &source.modules {
        let name = format!("{}.{}", k.0, k.1);
        let prefix = m.kind.word().to_lowercase();
        let at = module_phase(m);
        match target.modules.get(k) {
            None => {
                let steps = vec![Step { sql: go(&m.def), ..at }];
                out.push(change(&prefix, m.kind.group(), &name, ChangeKind::Added, false, steps, None, Some(m.def.clone())));
            }
            Some(old) if old.def == m.def && old.kind == m.kind => {}
            Some(old) if old.kind != m.kind => {
                let steps = vec![step(P_DROP, go(format!("DROP {} IF EXISTS {};", old.kind.word(), qk(k)))), Step { sql: go(&m.def), ..at }];
                out.push(change(&prefix, m.kind.group(), &name, ChangeKind::Changed, false, steps, Some(old.def.clone()), Some(m.def.clone())));
            }
            Some(old) => {
                let steps = vec![Step { sql: go(create_or_alter(&m.def)), ..at }];
                out.push(change(&prefix, m.kind.group(), &name, ChangeKind::Changed, false, steps, Some(old.def.clone()), Some(m.def.clone())));
            }
        }
    }
    for (k, m) in target.modules.iter().filter(|(k, _)| !source.modules.contains_key(*k)) {
        // Dropping a table drops its triggers.
        if m.parent.as_ref().is_some_and(|p| !source.tables.contains_key(p)) {
            continue;
        }
        let phase = if m.kind == ModuleKind::Function { P_DROP_OTHER } else { P_DROP };
        let steps = vec![step(phase, go(format!("DROP {} IF EXISTS {};", m.kind.word(), qk(k))))];
        out.push(change(&m.kind.word().to_lowercase(), m.kind.group(), &format!("{}.{}", k.0, k.1), ChangeKind::Removed, false, steps, Some(m.def.clone()), None));
    }
    out
}

/// Returns true when the change may lose data.
fn alter_column(t: &str, o: &MsColumn, c: &MsColumn, steps: &mut Vec<Step>) -> bool {
    let col = quote(&c.name);
    if o.identity != c.identity || o.computed.is_some() || c.computed.is_some() {
        if o.computed.is_some() && c.computed.is_some() {
            // A computed column is replaced: drop and add.
            steps.push(step(P_TABLES, go(format!("ALTER TABLE {t} DROP COLUMN {col};"))));
            steps.push(step(P_TABLES, go(format!("ALTER TABLE {t} ADD {};", col_def(c)))));
            return false;
        }
        steps.push(step(P_TABLES, format!("-- {t}.{col}: identity or computed-column changes need a new column and a copy; write this change by hand.")));
        return true;
    }
    let mut destructive = false;
    if o.data_type != c.data_type || o.not_null != c.not_null {
        destructive = o.data_type != c.data_type;
        steps.push(step(P_TABLES, go(format!("ALTER TABLE {t} ALTER COLUMN {col} {} {};", c.data_type, if c.not_null { "NOT NULL" } else { "NULL" }))));
    }
    if o.default != c.default || o.default_name != c.default_name {
        if o.default.is_some() {
            steps.push(step(P_DROP, drop_default(t, o)));
        }
        if let Some(add) = add_default(t, c) {
            steps.push(step(P_KEYS, add));
        }
    }
    destructive
}

/// Everything in `m` as changes against an empty database (capture, squash).
pub fn create_all(m: &MsModel) -> Vec<Change> {
    compare(m, &MsModel::default())
}

/// The schema model: one file per object.
pub fn files(m: &MsModel) -> BTreeMap<String, String> {
    let f = crate::model::file_name;
    let mut out = BTreeMap::new();
    for (k, t) in &m.tables {
        out.insert(format!("{}/tables/{}.sql", f(&k.0), f(&k.1)), table_ddl(k, t));
    }
    for (k, md) in &m.modules {
        let dir = match md.kind {
            ModuleKind::View => "views",
            ModuleKind::Procedure => "procedures",
            ModuleKind::Function => "functions",
            ModuleKind::Trigger => "triggers",
        };
        out.insert(format!("{}/{dir}/{}.sql", f(&k.0), f(&k.1)), go(&md.def));
    }
    for (k, s) in &m.sequences {
        out.insert(format!("{}/sequences/{}.sql", f(&k.0), f(&k.1)), sequence_ddl(k, s));
    }
    for (k, ddl) in &m.types {
        out.insert(format!("{}/types/{}.sql", f(&k.0), f(&k.1)), go(ddl));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_and_create_or_alter() {
        assert_eq!(type_name("nvarchar", false, "", 200, 0, 0), "nvarchar(100)");
        assert_eq!(type_name("varbinary", false, "", -1, 0, 0), "varbinary(max)");
        assert_eq!(type_name("decimal", false, "", 9, 10, 2), "decimal(10,2)");
        assert_eq!(type_name("money_amount", true, "dbo", 9, 12, 2), "[dbo].[money_amount]");
        assert_eq!(create_or_alter("-- note\n/* x */ create view v as select 1"), "-- note\n/* x */ CREATE OR ALTER view v as select 1");
        assert_eq!(create_or_alter("CREATE OR ALTER PROC p AS SELECT 1"), "CREATE OR ALTER PROC p AS SELECT 1");
        assert_eq!(normalize("a  \r\nb\t\r\n\r\n"), "a\nb");
        assert_eq!(normalize("CREATE   VIEW v AS SELECT 1"), "CREATE VIEW v AS SELECT 1", "how SQL Server stores CREATE OR ALTER");
        assert_eq!(normalize("create or  alter view v AS SELECT 1"), "CREATE view v AS SELECT 1");
    }

    #[test]
    fn unnamed_constraints_match_by_definition() {
        let pk = |name: &str| MsConstraint { name: name.into(), system_named: true, def: "PRIMARY KEY CLUSTERED ([id] ASC)".into(), kind: "PK".into(), cols: "id".into() };
        let table = |c: MsConstraint| MsTable { columns: vec![], constraints: vec![c], indexes: BTreeMap::new() };
        let k = ("dbo".to_string(), "orders".to_string());
        let a = MsModel { tables: [(k.clone(), table(pk("PK__orders__1")))].into(), ..Default::default() };
        let b = MsModel { tables: [(k, table(pk("PK__orders__2")))].into(), ..Default::default() };
        assert!(diff(&a, &b).is_empty(), "random names are not a difference");
    }
}
