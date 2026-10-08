//! Flyway's command-line spellings (`flyway -url=… -user=… -locations=filesystem:sql migrate`),
//! always accepted next to LiftOff's own flags. Translated before clap parses anything.

#[derive(Debug, Default, PartialEq)]
pub struct Adhoc {
    pub url: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub schemas: Option<Vec<String>>,
    pub default_schema: Option<String>,
    pub locations: Option<String>,
    pub table: Option<String>,
    pub allow_clean: bool,
}

/// Returns LiftOff arguments plus the connection settings given on the command line.
/// Flyway puts options before the command; translated options are appended after it, where
/// clap expects command-specific flags (global flags work in any position).
pub fn translate(args: Vec<String>) -> Result<(Vec<String>, Adhoc), String> {
    let mut out = Vec::new();
    let mut tail = Vec::new();
    let mut adhoc = Adhoc::default();
    for (i, a) in args.into_iter().enumerate() {
        let flyway_style = i > 0 && a.starts_with('-') && !a.starts_with("--") && a.len() > 2;
        if !flyway_style {
            out.push(a);
            continue;
        }
        let (key, value) = match a[1..].split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (a[1..].to_string(), None),
        };
        let v = || value.clone().ok_or_else(|| format!("-{key} needs a value, e.g. -{key}=…"));
        let yes = || value.as_deref().is_none_or(|v| v.eq_ignore_ascii_case("true"));
        match key.as_str() {
            "url" => adhoc.url = Some(v()?),
            "user" => adhoc.user = Some(v()?),
            "password" => adhoc.password = Some(v()?),
            "schemas" => adhoc.schemas = Some(v()?.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()),
            "defaultSchema" => adhoc.default_schema = Some(v()?),
            "locations" => {
                let l = v()?;
                let first = l.split(',').next().unwrap_or("").trim().to_string();
                match first.strip_prefix("filesystem:") {
                    Some(f) => adhoc.locations = Some(f.to_string()),
                    None => return Err(format!("-locations={l}: LiftOff reads scripts from one folder; use filesystem:<folder>")),
                }
                if l.contains(',') {
                    return Err(format!("-locations={l}: LiftOff reads scripts from one folder"));
                }
            }
            "table" => adhoc.table = Some(v()?),
            "cleanDisabled" => adhoc.allow_clean = value.as_deref().is_some_and(|v| v.eq_ignore_ascii_case("false")),
            "environment" => out.extend(["--environment".into(), v()?]),
            "outputType" => out.extend(["--output-type".into(), v()?.to_lowercase()]),
            "workingDirectory" => out.extend(["--project-dir".into(), v()?]),
            "target" => tail.extend(["--target".into(), v()?]),
            "outOfOrder" if yes() => tail.push("--out-of-order".into()),
            "outOfOrder" => {}
            "baselineVersion" => tail.extend(["--version".into(), v()?]),
            "baselineDescription" => tail.extend(["--description".into(), v()?]),
            "drift" => tail.push("--drift".into()),
            "changes" => tail.push("--changes".into()),
            "dryrun" | "dryRun" => tail.push("--dry-run".into()),
            // Logging and prompt switches: LiftOff is already non-interactive and logs to stderr.
            "X" | "q" | "n" => {}
            "configFiles" => return Err("-configFiles: convert the Flyway config once with `liftoff init --from-flyway`".into()),
            other => return Err(format!("-{other} is a Flyway option LiftOff does not support")),
        }
    }
    out.extend(tail);
    Ok((out, adhoc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn translates_flyway_style() {
        let (out, adhoc) = translate(args("liftoff -url=jdbc:postgresql://db/shop -user=app -password=pw -schemas=sales,public -locations=filesystem:sql -target=5 -outOfOrder=true -outputType=JSON migrate")).unwrap();
        assert_eq!(out, args("liftoff --output-type json migrate --target 5 --out-of-order"));
        assert_eq!(adhoc.url.as_deref(), Some("jdbc:postgresql://db/shop"));
        assert_eq!(adhoc.schemas, Some(vec!["sales".to_string(), "public".to_string()]));
        assert_eq!(adhoc.locations.as_deref(), Some("sql"));
    }

    #[test]
    fn own_flags_and_values_pass_through() {
        let (out, adhoc) = translate(args("liftoff --environment staging check -drift -dryrun")).unwrap();
        assert_eq!(out, args("liftoff --environment staging check --drift --dry-run"));
        assert_eq!(adhoc, Adhoc::default());
        // A short LiftOff flag (-e, -C) is not mistaken for a Flyway option.
        assert_eq!(translate(args("liftoff -e dev info")).unwrap().0, args("liftoff -e dev info"));
    }

    #[test]
    fn unsupported_options_are_errors_not_ignored() {
        assert!(translate(args("liftoff -placeholders.owner=x migrate")).unwrap_err().contains("does not support"));
        assert!(translate(args("liftoff -configFiles=a.conf migrate")).unwrap_err().contains("--from-flyway"));
        assert!(translate(args("liftoff -locations=classpath:db migrate")).is_err());
    }
}
