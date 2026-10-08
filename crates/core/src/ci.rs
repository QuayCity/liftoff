//! CI workflow generator (S17): a GitHub Actions workflow that runs the project's migrations,
//! stage by stage. Secrets come from the repository's settings; nothing is written into the file.

use crate::config::{Config, Role};
use crate::error::{config, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CiOptions {
    /// environments to deploy to, in order; each waits for the one before
    pub stages: Vec<String>,
    /// the branch whose pushes deploy
    pub branch: String,
    /// run validate and a drift check (with an HTML report) before migrating
    pub checks: bool,
    /// shell command that installs the liftoff CLI on the runner
    pub install: String,
}

pub const DEFAULT_INSTALL: &str = "cargo install --locked --git https://github.com/YOUR-ORG/liftoff liftoff-cli";

/// `LIFTOFF_ENV_<NAME>_…` as the CLI reads it.
pub fn env_var(env: &str, field: &str) -> String {
    format!("LIFTOFF_ENV_{}_{field}", env.to_uppercase().replace('-', "_"))
}

fn yaml_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn github_actions(cfg: &Config, o: &CiOptions) -> Result<String> {
    if o.stages.is_empty() {
        return config("choose at least one environment to deploy to");
    }
    if o.branch.trim().is_empty() || o.install.trim().is_empty() {
        return config("a branch and an install command are needed");
    }
    for s in &o.stages {
        let env = cfg.env(s)?;
        if matches!(env.role, Role::Dev | Role::Scratch) {
            return config(format!("'{s}' is a {} database; CI deploys to test and production environments", crate::config::role_name(env.role)));
        }
    }
    let migrations = cfg.project.migrations.trim_end_matches('/');
    let mut y = format!(
        "# Written by LiftOff. Add these repository secrets: LIFTOFF_LICENSE{}\n\
         # (and {} if the connection URL is not in liftoff.toml).\n\
         name: Database migrations\n\
         on:\n  push:\n    branches: [{}]\n    paths: [{}, 'liftoff.toml']\n  workflow_dispatch:\n\
         concurrency:\n  group: liftoff-migrations\n  cancel-in-progress: false\n\
         jobs:\n",
        o.stages.iter().map(|s| format!(", {}", env_var(s, "PASSWORD"))).collect::<String>(),
        o.stages.iter().map(|s| env_var(s, "URL")).collect::<Vec<_>>().join(", "),
        yaml_str(&o.branch),
        yaml_str(&format!("{migrations}/**")),
    );
    let mut previous: Option<String> = None;
    for s in &o.stages {
        let job = s.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-");
        y.push_str(&format!("  {job}:\n    name: {}\n    runs-on: ubuntu-latest\n", yaml_str(&format!("Migrate {s}"))));
        if let Some(p) = &previous {
            y.push_str(&format!("    needs: {p}\n"));
        }
        // A GitHub environment of the same name holds approvals and its own secrets.
        y.push_str(&format!("    environment: {}\n", yaml_str(s)));
        y.push_str(&format!(
            "    env:\n      LIFTOFF_LICENSE: ${{{{ secrets.LIFTOFF_LICENSE }}}}\n      {pw}: ${{{{ secrets.{pw} }}}}\n",
            pw = env_var(s, "PASSWORD")
        ));
        y.push_str("    steps:\n      - uses: actions/checkout@v4\n");
        y.push_str(&format!("      - name: Install LiftOff\n        run: {}\n", yaml_str(&o.install)));
        let e = yaml_str(s);
        if o.checks {
            y.push_str(&format!("      - name: Validate\n        run: liftoff --environment {e} validate\n"));
            y.push_str(&format!(
                "      - name: Check for drift\n        run: liftoff --environment {e} check --drift --report checks-{job}.html\n"
            ));
        }
        y.push_str(&format!("      - name: Migrate\n        run: liftoff --environment {e} migrate\n"));
        if o.checks {
            y.push_str(&format!(
                "      - name: Keep the check report\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: checks-{job}\n          path: checks-{job}.html\n          if-no-files-found: ignore\n"
            ));
        }
        previous = Some(job);
    }
    Ok(y)
}

/// Writes .github/workflows/liftoff.yml in the project folder.
pub fn write(cfg: &Config, yaml: &str, overwrite: bool) -> Result<std::path::PathBuf> {
    let path = cfg.root.join(".github/workflows/liftoff.yml");
    if path.exists() && !overwrite {
        return config(format!("{} already exists", path.display()));
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, yaml)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Environment, Project};

    fn cfg() -> Config {
        let env = |role| Environment { url: "postgres://h/db".into(), user: None, password: None, role, allow_clean: false, placeholders: Default::default() };
        Config {
            root: std::env::temp_dir(),
            project: Project { name: "shop".into(), engine: "postgresql".into(), migrations: "migrations".into(), schemas: vec!["public".into()], history_table: "h".into(), filters: vec![], lock: Default::default(), placeholders: Default::default() },
            environments: [("dev".to_string(), env(Role::Dev)), ("staging".to_string(), env(Role::Test)), ("prod-eu".to_string(), env(Role::Prod))].into_iter().collect(),
        }
    }

    #[test]
    fn stages_run_in_order_with_secrets() {
        let o = CiOptions { stages: vec!["staging".into(), "prod-eu".into()], branch: "main".into(), checks: true, install: DEFAULT_INSTALL.into() };
        let y = github_actions(&cfg(), &o).unwrap();
        assert!(y.contains("  prod-eu:\n") && y.contains("    needs: staging\n"), "{y}");
        assert!(y.contains("LIFTOFF_ENV_PROD_EU_PASSWORD: ${{ secrets.LIFTOFF_ENV_PROD_EU_PASSWORD }}"), "{y}");
        assert!(y.contains("run: liftoff --environment 'staging' check --drift --report checks-staging.html"), "{y}");
        assert!(y.contains("paths: ['migrations/**', 'liftoff.toml']"), "{y}");
        assert!(!y.contains("postgres://"), "no connection details in the file");
        // No tabs: YAML forbids them for indentation.
        assert!(!y.contains('\t'));
        let o = CiOptions { stages: vec!["dev".into()], ..o };
        assert!(github_actions(&cfg(), &o).unwrap_err().to_string().contains("dev database"));
    }
}
