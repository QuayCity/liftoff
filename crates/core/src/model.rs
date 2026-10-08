//! Schema model (S05, C13): one readable file per object under schema-model/, so git keeps the
//! history of every table, view and function. Compared as text with what dev would write.

use crate::config::Config;
use crate::db;
use crate::diff::{self, Model};
use crate::error::{config, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const FOLDER: &str = "schema-model";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelChange {
    /// relative to schema-model/, with `/`
    pub path: String,
    /// tables, views, functions, …
    pub object_type: String,
    pub kind: diff::ChangeKind,
    /// the file as it is (None when new)
    pub before: Option<String>,
    /// what dev has (None when the object is gone)
    pub after: Option<String>,
}

/// Windows and Unix safe file names; object names keep their readability.
pub(crate) fn file_name(name: &str) -> String {
    name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect()
}

/// The files a model would have: relative path -> content.
pub fn files_from(m: &Model) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let extras = |designators: &[String]| -> String {
        let mut s = String::new();
        for g in m.grants.iter().filter(|g| designators.contains(&g.object)) {
            s.push_str(&format!("\n{}", diff::grant_sql(g, false)));
        }
        for (o, text) in &m.comments {
            let column = designators.iter().any(|d| d.split_once(' ').is_some_and(|(_, n)| o.starts_with(&format!("COLUMN {n}."))));
            if designators.contains(o) || column {
                s.push_str(&format!("\n{}", diff::comment_sql(o, Some(text))));
            }
        }
        s
    };
    let mut put = |path: String, body: String| {
        out.insert(path, format!("{}\n", body.trim_end()));
    };
    for (k, t) in &m.tables {
        let n = diff::qk(k);
        put(format!("{}/tables/{}.sql", file_name(&k.0), file_name(&k.1)), diff::table_ddl(k, t) + &extras(&[format!("TABLE {n}")]));
    }
    for (k, v) in &m.views {
        let n = diff::qk(k);
        let dir = if v.materialized { "materialized-views" } else { "views" };
        let names = [format!("TABLE {n}"), format!("VIEW {n}"), format!("MATERIALIZED VIEW {n}")];
        put(format!("{}/{dir}/{}.sql", file_name(&k.0), file_name(&k.1)), diff::view_ddl(k, v) + &extras(&names));
    }
    for (k, f) in &m.functions {
        let kw = if f.procedure { "PROCEDURE" } else { "FUNCTION" };
        let d = format!("{kw} {}.{}({})", db::quote_ident(&k.0), db::quote_ident(&f.name), f.args);
        let dir = if f.procedure { "procedures" } else { "functions" };
        put(format!("{}/{dir}/{}.sql", file_name(&k.0), file_name(&k.1)), f.def.clone() + &extras(&[d]));
    }
    for (k, labels) in &m.enums {
        put(format!("{}/types/{}.sql", file_name(&k.0), file_name(&k.1)), diff::enum_ddl(k, labels) + &extras(&[format!("TYPE {}", diff::qk(k))]));
    }
    for (k, d) in &m.domains {
        put(format!("{}/domains/{}.sql", file_name(&k.0), file_name(&k.1)), diff::domain_ddl(k, d) + &extras(&[format!("DOMAIN {}", diff::qk(k))]));
    }
    for (k, s) in &m.sequences {
        put(format!("{}/sequences/{}.sql", file_name(&k.0), file_name(&k.1)), diff::sequence_ddl(k, s) + &extras(&[format!("SEQUENCE {}", diff::qk(k))]));
    }
    for ((s, t, name), def) in &m.triggers {
        put(format!("{}/triggers/{}.{}.sql", file_name(s), file_name(t), file_name(name)), def.clone());
    }
    for (name, schema) in &m.extensions {
        put(format!("extensions/{}.sql", file_name(name)), format!("CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};", db::quote_ident(name), db::quote_ident(schema)));
    }
    out
}

fn read_folder(root: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(base, &path, out)?;
            } else if path.extension().is_some_and(|e| e == "sql") {
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                // Compare without line-ending noise from git's autocrlf.
                out.insert(rel, std::fs::read_to_string(&path)?.replace("\r\n", "\n"));
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    let base = root.join(FOLDER);
    walk(&base, &base, &mut out)?;
    Ok(out)
}

/// The differences between the schema-model folder and what dev would write into it.
pub fn compare_files(on_disk: &BTreeMap<String, String>, dev: &BTreeMap<String, String>) -> Vec<ModelChange> {
    let paths: BTreeSet<&String> = on_disk.keys().chain(dev.keys()).collect();
    paths
        .into_iter()
        .filter_map(|p| {
            let (before, after) = (on_disk.get(p), dev.get(p));
            let kind = match (before, after) {
                (None, Some(_)) => diff::ChangeKind::Added,
                (Some(_), None) => diff::ChangeKind::Removed,
                (Some(a), Some(b)) if a != b => diff::ChangeKind::Changed,
                _ => return None,
            };
            let object_type = p.split('/').rev().nth(1).unwrap_or("other").to_string();
            Some(ModelChange { path: p.clone(), object_type, kind, before: before.cloned(), after: after.cloned() })
        })
        .collect()
}

pub async fn status(cfg: &Config, dev: Option<&str>) -> Result<Vec<ModelChange>> {
    let (name, env) = cfg.pick_role(dev, crate::config::Role::Dev)?;
    let c = db::Conn::open(&name, env).await?;
    let files = match diff::model_of(cfg, &c).await? {
        diff::Schema::Pg(m) => files_from(&m),
        diff::Schema::Ms(m) => crate::mssql_diff::files(&m).into_iter().map(|(k, v)| (k, format!("{}\n", v.trim_end()))).collect(),
    };
    Ok(compare_files(&read_folder(&cfg.root)?, &files))
}

/// Writes (or deletes) exactly the given changes; files outside schema-model/ are refused.
pub fn save(cfg: &Config, changes: &[ModelChange]) -> Result<usize> {
    let base = cfg.root.join(FOLDER);
    for c in changes {
        if c.path.contains("..") || Path::new(&c.path).is_absolute() || !c.path.ends_with(".sql") {
            return config(format!("'{}' is not a schema-model file", c.path));
        }
        let path = base.join(&c.path);
        match &c.after {
            Some(text) => {
                std::fs::create_dir_all(path.parent().unwrap())?;
                std::fs::write(&path, text)?;
            }
            None => {
                if path.exists() {
                    std::fs::remove_file(&path)?;
                }
            }
        }
    }
    Ok(changes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_text_and_ignores_line_endings() {
        let mut disk = BTreeMap::new();
        disk.insert("public/tables/a.sql".to_string(), "CREATE TABLE a ();\n".to_string());
        disk.insert("public/tables/old.sql".to_string(), "x\n".to_string());
        disk.insert("public/views/v.sql".to_string(), "same\n".to_string());
        let mut dev = BTreeMap::new();
        dev.insert("public/tables/a.sql".to_string(), "CREATE TABLE a (id int);\n".to_string());
        dev.insert("public/views/v.sql".to_string(), "same\n".to_string());
        dev.insert("public/functions/f(x int).sql".to_string(), "fn\n".to_string());
        let c = compare_files(&disk, &dev);
        let got: Vec<(&str, diff::ChangeKind, &str)> = c.iter().map(|c| (c.path.as_str(), c.kind, c.object_type.as_str())).collect();
        assert_eq!(got, [
            ("public/functions/f(x int).sql", diff::ChangeKind::Added, "functions"),
            ("public/tables/a.sql", diff::ChangeKind::Changed, "tables"),
            ("public/tables/old.sql", diff::ChangeKind::Removed, "tables"),
        ]);
        assert_eq!(file_name("a/b:c"), "a_b_c");
    }
}
