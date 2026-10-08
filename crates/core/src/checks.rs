//! Pre-deploy checks: drift (C16), changes report (C15) and dry run (C10), from one scratch rebuild.

use crate::config::Config;
use crate::diff::{self, Change};
use crate::error::Result;
use crate::runner::{self, Level, Log, MigrateOptions, State};
use crate::{db, migration::Version};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy)]
pub struct CheckOptions {
    pub drift: bool,
    pub changes: bool,
    pub dry_run: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CheckReport {
    pub environment: String,
    /// the latest version applied on the environment (what drift is measured against)
    pub applied_up_to: Option<String>,
    /// what the environment has that its applied scripts did not create (changed by hand)
    pub drift: Option<Vec<Change>>,
    /// what the pending scripts will change on the environment
    pub changes: Option<Vec<Change>>,
    pub dry_run_sql: Option<String>,
    /// objects that exist but were not compared (row-level security, rules, …)
    #[serde(default)]
    pub not_compared: Vec<String>,
}

impl CheckReport {
    pub fn has_drift(&self) -> bool {
        self.drift.as_ref().is_some_and(|d| !d.is_empty())
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A self-contained HTML record of a check (no scripts, no external files), for audits and reviews.
pub fn report_html(r: &CheckReport, project: &str, generated_at: &str) -> String {
    let section = |title: &str, changes: &Option<Vec<Change>>, none: &str| -> String {
        let Some(list) = changes else { return String::new() };
        let mut h = format!("<h2>{} ({})</h2>", esc(title), list.len());
        if list.is_empty() {
            h.push_str(&format!("<p class=ok>{}</p>", esc(none)));
        }
        for c in list {
            h.push_str(&format!(
                "<details><summary><b>{}</b> {} {}</summary><div class=cols><div><h3>Before</h3><pre>{}</pre></div><div><h3>After</h3><pre>{}</pre></div></div><h3>SQL</h3><pre>{}</pre></details>",
                esc(&format!("{:?}", c.kind).to_lowercase()),
                esc(&c.name),
                if c.destructive { "<span class=warn>may lose data</span>" } else { "" },
                esc(c.before.as_deref().unwrap_or("(does not exist)")),
                esc(c.after.as_deref().unwrap_or("(does not exist)")),
                esc(&c.sql),
            ));
        }
        h
    };
    let mut body = format!(
        "<h1>Checks for {}</h1><p>Project {} &middot; generated {} &middot; applied up to {}</p>",
        esc(&r.environment),
        esc(project),
        esc(generated_at),
        esc(r.applied_up_to.as_deref().unwrap_or("nothing"))
    );
    if !r.not_compared.is_empty() {
        body.push_str("<h2>Not compared</h2><ul>");
        for n in &r.not_compared {
            body.push_str(&format!("<li>{}</li>", esc(n)));
        }
        body.push_str("</ul>");
    }
    body.push_str(&section("Drift", &r.drift, "No drift: the database matches its applied scripts."));
    body.push_str(&section("Pending changes", &r.changes, "The pending scripts change nothing."));
    if let Some(sql) = &r.dry_run_sql {
        body.push_str(&format!("<h2>Dry-run script</h2><pre>{}</pre>", esc(sql)));
    }
    format!(
        "<!doctype html><html lang=en><head><meta charset=utf-8><title>Checks for {}</title><style>\
         body{{font:14px system-ui,sans-serif;margin:2rem;max-width:72rem;color:#15181c}}\
         pre{{background:#eef0f3;padding:.75rem;overflow:auto;white-space:pre-wrap}}\
         .cols{{display:grid;grid-template-columns:1fr 1fr;gap:1rem}}.ok{{color:#17734a}}.warn{{color:#b42d25;margin-left:.5rem}}\
         summary{{cursor:pointer;padding:.25rem 0}}</style></head><body>{body}</body></html>",
        esc(&r.environment)
    )
}

/// ponytail: the expected state is rebuilt by running every script up to the environment's latest
/// applied version; scripts the environment skipped (out of order) and outdated repeatables are not
/// modelled, so they can show up as drift.
pub async fn check(cfg: &Config, env_name: Option<&str>, scratch: Option<&str>, opts: CheckOptions, log: Log<'_>) -> Result<CheckReport> {
    let (name, env) = cfg.pick(env_name)?;
    let mut report = CheckReport { environment: name.clone(), ..Default::default() };

    if opts.drift || opts.changes {
        let (scratch_name, scratch_env) = diff::scratch_env(cfg, scratch)?;
        if scratch_name == name {
            return Err(crate::Error::Config("the scratch database cannot be the environment being checked".into()));
        }
        let infos = runner::info(cfg, Some(&name)).await?;
        let applied = infos
            .iter()
            .filter(|i| matches!(i.state, State::Applied | State::Baseline))
            .filter_map(|i| i.version.clone())
            .max_by_key(|v| Version::parse(v));
        report.applied_up_to = applied.clone();
        // "0" builds nothing: an environment without history should match an empty database.
        let target = applied.unwrap_or_else(|| "0".into());
        let s = diff::rebuild_scratch(cfg, &scratch_name, scratch_env, Some(&target), log).await?;
        // (rebuild_scratch runs with allow_non_empty: it has just erased the database itself)
        let expected = diff::model_of(cfg, &s).await?;

        if opts.drift {
            log(Level::Info, &format!("Comparing {name} with what its applied scripts build"));
            let c = db::connect(&name, env).await?;
            let actual = diff::model_of(cfg, &c).await?;
            let drift = diff::diff(&actual, &expected);
            report.not_compared = diff::not_compared(&actual, &expected, &name, "its scripts");
            log(Level::Info, &if drift.is_empty() { format!("No drift on {name}") } else { format!("{} object(s) on {name} differ from the scripts", drift.len()) });
            report.drift = Some(drift);
        }
        if opts.changes {
            log(Level::Info, "Running the pending scripts on the scratch database");
            runner::migrate(cfg, Some(&scratch_name), MigrateOptions { out_of_order: true, ..Default::default() }, log).await?;
            let after = diff::model_of(cfg, &s).await?;
            let changes = diff::diff(&after, &expected);
            if report.not_compared.is_empty() {
                report.not_compared = diff::not_compared(&after, &expected, "after the scripts", "now");
            }
            log(Level::Info, &format!("The pending scripts change {} object(s)", changes.len()));
            report.changes = Some(changes);
        }
    }
    if opts.dry_run {
        let r = runner::migrate(cfg, Some(&name), MigrateOptions { dry_run: true, ..Default::default() }, log).await?;
        report.dry_run_sql = r.dry_run_sql;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_escapes_and_is_self_contained() {
        let r = CheckReport {
            environment: "prod <eu>".into(),
            drift: Some(vec![]),
            dry_run_sql: Some("select '<script>';".into()),
            not_compared: vec!["rules: 1 in prod, 0 in its scripts".into()],
            ..Default::default()
        };
        let html = report_html(&r, "shop", "2026-10-08T12:00:00Z");
        assert!(html.contains("Checks for prod &lt;eu&gt;") && html.contains("&lt;script&gt;") && !html.contains("<script>"));
        assert!(html.contains("No drift") && html.contains("Not compared"));
        assert!(!html.contains("http"), "no external resources");
    }
}
