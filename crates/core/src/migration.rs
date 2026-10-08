//! Migration files on disk: naming, versions, checksums, next version, statement splitting.

use crate::error::{config, Result};
use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Versioned,
    Repeatable,
    Undo,
    Baseline,
}

/// Numeric version: `1.2`, `1_2`, `20261008.1104`. Trailing zero parts are insignificant (1.0 == 1).
#[derive(Debug, Clone, Eq)]
pub struct Version {
    parts: Vec<u64>,
    pub text: String,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let mut parts = s.split(['.', '_']).map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
        while parts.len() > 1 && parts.last() == Some(&0) {
            parts.pop();
        }
        Some(Version { parts, text: s.to_string() })
    }
}

impl PartialEq for Version {
    fn eq(&self, o: &Self) -> bool { self.parts == o.parts }
}
impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering { self.parts.cmp(&o.parts) }
}
impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}

#[derive(Debug, Clone)]
pub struct Script {
    pub kind: Kind,
    pub version: Option<Version>,
    pub description: String,
    pub file_name: String,
    pub path: PathBuf,
    pub checksum: i32,
    pub sql: String,
}

/// `V1.2__add_orders.sql` -> (Versioned, Some("1.2"), "add orders")
pub fn parse_name(name: &str) -> Option<(Kind, Option<String>, String)> {
    let stem = name.strip_suffix(".sql")?;
    let (head, desc) = stem.split_once("__")?;
    let kind = match head.chars().next()? {
        'V' => Kind::Versioned,
        'R' => Kind::Repeatable,
        'U' => Kind::Undo,
        'B' => Kind::Baseline,
        _ => return None,
    };
    let version = &head[1..];
    let version = match (kind, version.is_empty()) {
        (Kind::Repeatable, true) => None,
        (Kind::Repeatable, false) | (_, true) => return None,
        _ => Some(version.to_string()),
    };
    Some((kind, version, desc.replace('_', " ")))
}

/// All migration scripts under `dir` (recursive), sorted: versioned by version, then repeatables by description.
pub fn scan(dir: &Path) -> Result<Vec<Script>> {
    let mut files = Vec::new();
    if dir.exists() {
        walk(dir, &mut files)?;
    }
    let mut scripts = Vec::new();
    for path in files {
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some((kind, version, description)) = parse_name(&file_name) else { continue };
        let version = match version {
            Some(v) => Some(Version::parse(&v).ok_or_else(|| crate::Error::Config(format!("{file_name}: version '{v}' must be numbers separated by . or _")))?),
            None => None,
        };
        let bytes = std::fs::read(&path)?;
        let sql = String::from_utf8(bytes.clone()).or_else(|_| config(format!("{file_name} is not valid UTF-8")))?;
        scripts.push(Script { kind, version, description, file_name, path, checksum: checksum(&bytes), sql });
    }
    for kind in [Kind::Versioned, Kind::Undo, Kind::Baseline] {
        let mut seen: Vec<&Script> = scripts.iter().filter(|s| s.kind == kind).collect();
        seen.sort_by(|a, b| a.version.cmp(&b.version));
        if let Some(w) = seen.windows(2).find(|w| w[0].version == w[1].version) {
            return config(format!("two scripts share version {}: {} and {}", w[0].version.as_ref().unwrap().text, w[0].file_name, w[1].file_name));
        }
    }
    scripts.sort_by(|a, b| order_key(a).cmp(&order_key(b)));
    Ok(scripts)
}

fn order_key(s: &Script) -> (u8, Option<Version>, String) {
    (if s.kind == Kind::Repeatable { 1 } else { 0 }, s.version.clone(), s.description.clone())
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() { walk(&path, out)? } else { out.push(path) }
    }
    Ok(())
}

/// CRC32 over the script's lines without line terminators (`\n`, `\r\n` or a lone `\r`), BOM
/// stripped, so checkouts with different line endings match. Matches the checksums Flyway stores:
/// pinned by black-box fixtures in tests/fixtures/checksum (tests/checksum.rs).
pub fn checksum(bytes: &[u8]) -> i32 {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut h = crc32fast::Hasher::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' || bytes[i] == b'\r' {
            h.update(&bytes[start..i]);
            if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    h.update(&bytes[start..]);
    h.finalize() as i32
}

/// Timestamp versions (UTC `yyyyMMdd.HHmm`) unless the project already uses short counters,
/// then the last part is incremented with its padding kept (`V007` -> `008`, `1.2` -> `1.3`).
pub fn next_version(existing: &[Script], now: time::OffsetDateTime) -> String {
    let latest = existing.iter().filter(|s| s.kind == Kind::Versioned).filter_map(|s| s.version.as_ref()).max();
    let now = now.to_offset(time::UtcOffset::UTC);
    let stamp = format!("{:04}{:02}{:02}.{:02}{:02}", now.year(), now.month() as u8, now.day(), now.hour(), now.minute());
    match latest {
        None => stamp,
        Some(v) if v.text.split(['.', '_']).next().is_some_and(|p| p.len() >= 8) => {
            let candidate = Version::parse(&stamp).unwrap();
            if candidate > *v { stamp } else { bump(&v.text) }
        }
        Some(v) => bump(&v.text),
    }
}

fn bump(text: &str) -> String {
    let cut = text.rfind(['.', '_']).map(|i| i + 1).unwrap_or(0);
    let (head, last) = text.split_at(cut);
    let n: u64 = last.parse().unwrap_or(0) + 1;
    format!("{head}{n:0width$}", width = last.len())
}

/// Replaces `${name}` with its value. When the project uses placeholders, a `${name}` without a
/// value is an error naming it; projects without placeholders run their scripts untouched.
pub fn apply_placeholders(sql: &str, values: &std::collections::BTreeMap<String, String>, strict: bool, script: &str) -> Result<String> {
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    let mut missing = Vec::new();
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let end = after.find('}');
        let name = end.map(|e| &after[..e]).filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')));
        match (name, end) {
            (Some(n), Some(e)) => {
                match values.get(n) {
                    Some(v) => out.push_str(v),
                    None => {
                        if strict && !missing.contains(&n) {
                            missing.push(n);
                        }
                        out.push_str(&rest[i..i + 2 + e + 1]);
                    }
                }
                rest = &after[e + 1..];
            }
            _ => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    if !missing.is_empty() {
        return config(format!("{script} uses placeholders with no value: {}", missing.join(", ")));
    }
    Ok(out)
}

/// Postgres statements that cannot run inside a transaction block.
/// ponytail: keyword scan, so a match inside a comment or string also counts (safe direction: runs without a transaction).
pub fn needs_no_transaction(sql: &str) -> bool {
    let up = sql.to_uppercase();
    ["CONCURRENTLY", "VACUUM", "CREATE DATABASE", "DROP DATABASE", "ALTER SYSTEM", "CREATE TABLESPACE", "DROP TABLESPACE"]
        .iter()
        .any(|k| up.contains(k))
}

/// SQL Server statements that cannot run inside a transaction.
pub fn tsql_needs_no_transaction(sql: &str) -> bool {
    let up = sql.to_uppercase();
    ["CREATE DATABASE", "ALTER DATABASE", "DROP DATABASE", "BACKUP ", "RESTORE ", "RECONFIGURE", "CREATE FULLTEXT", "ALTER FULLTEXT", "DROP FULLTEXT"]
        .iter()
        .any(|k| up.contains(k))
}

/// Splits a SQL Server script into batches on `GO` lines (`GO 3` runs a batch three times), as
/// sqlcmd and SSMS do. A GO inside a string or a block comment does not count.
pub fn split_batches(sql: &str) -> Vec<(String, u32)> {
    let (mut out, mut cur) = (Vec::new(), String::new());
    let (mut in_string, mut comment_depth) = (false, 0u32);
    for line in sql.split_inclusive('\n') {
        if !in_string && comment_depth == 0 {
            let t = line.trim();
            let t = t.split("--").next().unwrap_or("").trim();
            let mut words = t.split_whitespace();
            if words.next().is_some_and(|w| w.eq_ignore_ascii_case("go")) {
                let count = words.next().map(|n| n.parse::<u32>());
                if words.next().is_none() && !matches!(count, Some(Err(_))) {
                    if !cur.trim().is_empty() {
                        out.push((std::mem::take(&mut cur), count.and_then(|c| c.ok()).unwrap_or(1)));
                    }
                    cur.clear();
                    continue;
                }
            }
        }
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\'' if comment_depth == 0 => in_string = !in_string,
                b'-' if !in_string && comment_depth == 0 && b.get(i + 1) == Some(&b'-') => break,
                b'/' if !in_string && b.get(i + 1) == Some(&b'*') => {
                    comment_depth += 1;
                    i += 1;
                }
                b'*' if !in_string && comment_depth > 0 && b.get(i + 1) == Some(&b'/') => {
                    comment_depth -= 1;
                    i += 1;
                }
                _ => {}
            }
            i += 1;
        }
        cur.push_str(line);
    }
    if !cur.trim().is_empty() {
        out.push((cur, 1));
    }
    out
}

/// Splits a Postgres script into statements on `;`, respecting quotes, dollar quotes and comments.
/// Only needed for scripts that run outside a transaction (each statement is its own implicit one).
pub fn split_statements(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let (mut out, mut start, mut i) = (Vec::new(), 0, 0);
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q { i += 1 }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' { i += 1 }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1 }
                i += 1;
            }
            b'$' => {
                // $tag$ ... $tag$ (tag may be empty)
                if let Some(end) = sql[i + 1..].find('$') {
                    let tag = &sql[i..i + end + 2];
                    if tag[1..tag.len() - 1].chars().all(|c| c.is_alphanumeric() || c == '_') {
                        if let Some(close) = sql[i + tag.len()..].find(tag) {
                            i += tag.len() + close + tag.len() - 1;
                        }
                    }
                }
            }
            b';' => {
                push(&mut out, &sql[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    push(&mut out, &sql[start.min(sql.len())..]);
    out
}

fn push(out: &mut Vec<String>, s: &str) {
    let has_code = s.lines().any(|l| { let t = l.trim(); !t.is_empty() && !t.starts_with("--") });
    if has_code {
        out.push(s.trim().to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(parse_name("V1.2__add_orders.sql"), Some((Kind::Versioned, Some("1.2".into()), "add orders".into())));
        assert_eq!(parse_name("R__views.sql"), Some((Kind::Repeatable, None, "views".into())));
        assert_eq!(parse_name("U3__x.sql").unwrap().0, Kind::Undo);
        assert_eq!(parse_name("R1__x.sql"), None);
        assert_eq!(parse_name("V__x.sql"), None);
        assert_eq!(parse_name("readme.md"), None);
    }

    #[test]
    fn versions_sort_numerically() {
        let v = |s| Version::parse(s).unwrap();
        assert!(v("1.10") > v("1.9"));
        assert!(v("2") > v("1.99"));
        assert_eq!(v("1.0"), v("1"));
        assert_eq!(v("1_2"), v("1.2"));
        assert!(Version::parse("1.a").is_none());
    }

    #[test]
    fn checksum_ignores_line_endings_and_bom() {
        let lf = checksum(b"create table a();\nselect 1;\n");
        assert_eq!(lf, checksum(b"create table a();\r\nselect 1;\r\n"));
        assert_eq!(lf, checksum(b"\xEF\xBB\xBFcreate table a();\nselect 1;\n"));
        assert_ne!(lf, checksum(b"create table b();\nselect 1;\n"));
    }

    #[test]
    fn next_versions() {
        let now = time::macros::datetime!(2026-10-08 11:04 UTC);
        let mk = |v: &str| Script { kind: Kind::Versioned, version: Version::parse(v), description: String::new(), file_name: String::new(), path: PathBuf::new(), checksum: 0, sql: String::new() };
        assert_eq!(next_version(&[], now), "20261008.1104");
        assert_eq!(next_version(&[mk("007")], now), "008");
        assert_eq!(next_version(&[mk("1.9")], now), "1.10");
        assert_eq!(next_version(&[mk("20261001.0900")], now), "20261008.1104");
        // Same minute as the latest timestamp: bump instead of colliding.
        assert_eq!(next_version(&[mk("20261008.1104")], now), "20261008.1105");
    }

    #[test]
    fn go_batches() {
        let sql = "create table a (id int)
GO
create proc p as select 'GO
go' /* 
GO
 */
  go 2 -- twice

GO
select 1
go;
";
        let b = split_batches(sql);
        assert_eq!(b.len(), 3, "{b:#?}");
        assert_eq!(b[0], ("create table a (id int)
".to_string(), 1));
        assert!(b[1].0.contains("'GO
go'") && b[1].0.contains("/* 
GO
 */") && b[1].1 == 2, "{b:#?}");
        assert_eq!(b[2].0, "select 1
go;
", "`go;` is not a separator");
        assert_eq!(split_batches("select 1"), [("select 1".to_string(), 1)]);
        assert!(split_batches("
GO
").is_empty());
    }

    #[test]
    fn placeholders() {
        let mut v = std::collections::BTreeMap::new();
        v.insert("app_user".to_string(), "svc_shop".to_string());
        let sql = "grant select on orders to ${app_user}; select '${not a name}', $$x$$;";
        assert_eq!(apply_placeholders(sql, &v, true, "V1").unwrap(), "grant select on orders to svc_shop; select '${not a name}', $$x$$;");
        assert!(apply_placeholders("${who}", &v, true, "V1").unwrap_err().to_string().contains("V1 uses placeholders with no value: who"));
        assert_eq!(apply_placeholders("${who}", &v, false, "V1").unwrap(), "${who}", "projects without placeholders are untouched");
    }

    #[test]
    fn splits_statements() {
        let sql = "create table a(x text default 'a;b'); -- c;\n\
                   create function f() returns int as $body$ select 1; $body$ language sql;\n\
                   /* x; */ create index concurrently i on a(x);\n-- trailing comment";
        let s = split_statements(sql);
        assert_eq!(s.len(), 3, "{s:#?}");
        assert!(s[1].contains("$body$ select 1; $body$"));
        assert!(needs_no_transaction(&s[2]));
        assert!(!needs_no_transaction(&s[0]));
    }
}
