//! Pre-deploy checks: drift (C16), changes report (C15) and dry run (C10), from one scratch rebuild.

use crate::config::Config;
use crate::diff::{self, Change};
use crate::error::Result;
use crate::runner::{self, Level, Log, MigrateOptions, State};
use crate::{db, migration::Version};
use serde::Serialize;

#[derive(Debug, Default, Clone, Copy)]
pub struct CheckOptions {
    pub drift: bool,
    pub changes: bool,
    pub dry_run: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct CheckReport {
    pub environment: String,
    /// the latest version applied on the environment (what drift is measured against)
    pub applied_up_to: Option<String>,
    /// what the environment has that its applied scripts did not create (changed by hand)
    pub drift: Option<Vec<Change>>,
    /// what the pending scripts will change on the environment
    pub changes: Option<Vec<Change>>,
    pub dry_run_sql: Option<String>,
}

impl CheckReport {
    pub fn has_drift(&self) -> bool {
        self.drift.as_ref().is_some_and(|d| !d.is_empty())
    }
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
        let expected = diff::model_of(cfg, &s).await?;

        if opts.drift {
            log(Level::Info, &format!("Comparing {name} with what its applied scripts build"));
            let c = db::connect(&name, env).await?;
            let drift = diff::diff(&diff::model_of(cfg, &c).await?, &expected);
            log(Level::Info, &if drift.is_empty() { format!("No drift on {name}") } else { format!("{} object(s) on {name} differ from the scripts", drift.len()) });
            report.drift = Some(drift);
        }
        if opts.changes {
            log(Level::Info, "Running the pending scripts on the scratch database");
            runner::migrate(cfg, Some(&scratch_name), MigrateOptions { out_of_order: true, ..Default::default() }, log).await?;
            let after = diff::model_of(cfg, &s).await?;
            let changes = diff::diff(&after, &expected);
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
