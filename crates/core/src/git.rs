//! Version control for the Commit workspace (S14), through the user's own `git`, so their
//! credentials, hooks and SSH config apply. Never prompts: a credential prompt fails instead.

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Default, Serialize)]
pub struct Status {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    /// added, modified, deleted, renamed, untracked, conflicted
    pub change: String,
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .output()
        .map_err(|e| Error::Config(format!("git could not be started ({e}); install Git and make sure it is on PATH")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(Error::Git(classify(&err), err))
    }
}

/// Stable codes for the failures the app has a specific answer to.
fn classify(stderr: &str) -> &'static str {
    let e = stderr.to_lowercase();
    if e.contains("not a git repository") {
        "not_a_repository"
    } else if e.contains("rejected") && (e.contains("fetch first") || e.contains("non-fast-forward")) {
        "push_rejected"
    } else if e.contains("no upstream") || e.contains("has no upstream branch") {
        "no_upstream"
    } else if e.contains("not possible to fast-forward") || e.contains("diverging branches") {
        "diverged"
    } else if e.contains("authentication") || e.contains("could not read username") || e.contains("permission denied") {
        "auth"
    } else {
        "other"
    }
}

pub fn status(root: &Path) -> Result<Status> {
    let raw = git(root, &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"])?;
    Ok(parse_status(&raw))
}

fn parse_status(raw: &str) -> Status {
    let mut s = Status::default();
    let mut entries = raw.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        if let Some(h) = e.strip_prefix("# branch.head ") {
            s.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = e.strip_prefix("# branch.upstream ") {
            s.upstream = Some(u.to_string());
        } else if let Some(ab) = e.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            s.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            s.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(p) = e.strip_prefix("? ") {
            s.files.push(FileChange { path: p.to_string(), change: "untracked".into() });
        } else if e.starts_with("1 ") || e.starts_with("2 ") {
            // "1 XY sub mH mI mW hH hI path" / "2 XY … Xscore path\0origPath"
            let fields: Vec<&str> = e.splitn(if e.starts_with('1') { 9 } else { 10 }, ' ').collect();
            let xy = fields[1];
            let path = fields.last().unwrap().to_string();
            if e.starts_with('2') {
                entries.next(); // the original path of a rename
            }
            let change = if e.starts_with('2') {
                "renamed"
            } else if xy.contains('D') {
                "deleted"
            } else if xy.contains('A') {
                "added"
            } else {
                "modified"
            };
            s.files.push(FileChange { path, change: change.into() });
        } else if let Some(u) = e.strip_prefix("u ") {
            s.files.push(FileChange { path: u.rsplit(' ').next().unwrap_or(u).to_string(), change: "conflicted".into() });
        }
    }
    s
}

/// The change to one file: a diff for tracked files, the whole content for untracked ones.
pub fn diff(root: &Path, path: &str) -> Result<String> {
    let tracked = git(root, &["ls-files", "--", path])?;
    if tracked.trim().is_empty() {
        return Ok(std::fs::read_to_string(root.join(path)).unwrap_or_default());
    }
    git(root, &["diff", "HEAD", "--", path])
}

/// Commits exactly these paths (new files included), nothing else that happens to be staged.
pub fn commit(root: &Path, paths: &[String], message: &str) -> Result<String> {
    if paths.is_empty() {
        return Err(Error::Config("choose at least one file to commit".into()));
    }
    if message.trim().is_empty() {
        return Err(Error::Config("write a commit message".into()));
    }
    let mut add = vec!["add", "--all", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(root, &add)?;
    let mut commit = vec!["commit", "-m", message.trim(), "--"];
    commit.extend(paths.iter().map(String::as_str));
    git(root, &commit)?;
    Ok(git(root, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

/// Pushes the current branch; sets the upstream on its first push.
pub fn push(root: &Path) -> Result<()> {
    let st = status(root)?;
    match (st.upstream, st.branch) {
        (Some(_), _) => git(root, &["push"]).map(|_| ()),
        (None, Some(b)) => git(root, &["push", "--set-upstream", "origin", &b]).map(|_| ()),
        (None, None) => Err(Error::Config("not on a branch; check out a branch to push".into())),
    }
}

/// Fast-forward only: a pull never creates a merge commit from inside LiftOff.
pub fn pull(root: &Path) -> Result<()> {
    git(root, &["pull", "--ff-only"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 aa bb migrations/V1__a.sql\0\
                   1 A. N... 000000 100644 100644 00 cc liftoff.toml\0\
                   2 R. N... 100644 100644 100644 dd dd R100 migrations/V3__new name.sql\0migrations/V3__old.sql\0\
                   ? migrations/V4__b.sql\0";
        let s = parse_status(raw);
        assert_eq!((s.branch.as_deref(), s.upstream.as_deref(), s.ahead, s.behind), (Some("main"), Some("origin/main"), 2, 1));
        let files: Vec<(&str, &str)> = s.files.iter().map(|f| (f.path.as_str(), f.change.as_str())).collect();
        assert_eq!(files, [
            ("migrations/V1__a.sql", "modified"),
            ("liftoff.toml", "added"),
            ("migrations/V3__new name.sql", "renamed"),
            ("migrations/V4__b.sql", "untracked"),
        ]);
    }

    #[test]
    fn classifies_errors() {
        assert_eq!(classify("! [rejected] main -> main (fetch first)\nerror: failed to push"), "push_rejected");
        assert_eq!(classify("fatal: not a git repository (or any of the parent directories): .git"), "not_a_repository");
        assert_eq!(classify("fatal: Not possible to fast-forward, aborting."), "diverged");
    }

    /// A real repository with a bare remote: commit, push, a second clone pushes, the first is rejected, pull fixes it.
    #[test]
    fn round_trip_with_a_remote() {
        let base = std::env::temp_dir().join(format!("liftoff-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (remote, a, b) = (base.join("remote.git"), base.join("a"), base.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(&base, &["init", "--bare", "-b", "main", remote.to_str().unwrap()]);
        run(&a, &["init", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.test"), ("commit.gpgsign", "false")] {
            run(&a, &["config", k, v]);
        }
        run(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
        std::fs::create_dir_all(a.join("migrations")).unwrap();
        std::fs::write(a.join("migrations/V1__a.sql"), "select 1;\n").unwrap();
        std::fs::write(a.join("notes.txt"), "not part of the commit\n").unwrap();

        let st = status(&a).unwrap();
        assert_eq!(st.files.len(), 2);
        assert_eq!(diff(&a, "migrations/V1__a.sql").unwrap(), "select 1;\n");
        commit(&a, &["migrations/V1__a.sql".into()], "add V1").unwrap();
        assert_eq!(status(&a).unwrap().files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["notes.txt"], "only the chosen file was committed");
        push(&a).unwrap();
        assert_eq!(status(&a).unwrap().upstream.as_deref(), Some("origin/main"));

        run(&base, &["clone", remote.to_str().unwrap(), b.to_str().unwrap()]);
        for (k, v) in [("user.name", "Other"), ("user.email", "other@example.test"), ("commit.gpgsign", "false")] {
            run(&b, &["config", k, v]);
        }
        std::fs::write(b.join("migrations/V2__b.sql"), "select 2;\n").unwrap();
        commit(&b, &["migrations/V2__b.sql".into()], "add V2").unwrap();
        push(&b).unwrap();

        std::fs::write(a.join("migrations/V3__c.sql"), "select 3;\n").unwrap();
        commit(&a, &["migrations/V3__c.sql".into()], "add V3").unwrap();
        let err = push(&a).unwrap_err();
        assert!(matches!(&err, Error::Git("push_rejected", _)), "{err}");
        // Diverged history: a fast-forward pull refuses rather than merging behind the user's back.
        assert!(matches!(pull(&a).unwrap_err(), Error::Git("diverged", _)));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
