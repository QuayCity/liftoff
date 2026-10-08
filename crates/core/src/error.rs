use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

/// Every failure maps to a stable exit code and error code (architecture.md, CLI contract).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Config(String),
    #[error("could not connect to '{env}': {msg}")]
    Connect { env: String, msg: String },
    #[error("migration {script} failed: {msg}")]
    Migration { script: String, msg: String },
    #[error("{0}")]
    Validate(String),
    #[error("{0}")]
    License(String),
    #[error("drift found on '{0}': it has changes the migration scripts did not make")]
    Drift(String),
    #[error("'{0}' already has tables but no migration history. Baseline it first (`liftoff baseline --version …`), or run the scripts anyway with --allow-non-empty")]
    NotBaselined(String),
    /// a git failure: (kind for the app to act on, git's own message)
    #[error("{1}")]
    Git(&'static str, String),
    #[error("database error: {0}")]
    Db(#[from] tokio_postgres::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Config(_) => 2,
            Error::Connect { .. } => 10,
            Error::Migration { .. } => 11,
            Error::Validate(_) => 12,
            Error::License(_) => 20,
            Error::Drift(_) => 13,
            Error::NotBaselined(_) => 12,
            Error::Git(..) | Error::Db(_) | Error::Io(_) => 1,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Error::Config(_) => "LIFTOFF_CONFIG",
            Error::Connect { .. } => "LIFTOFF_CONNECT",
            Error::Migration { .. } => "LIFTOFF_MIGRATION_FAILED",
            Error::Validate(_) => "LIFTOFF_VALIDATE",
            Error::License(_) => "LIFTOFF_LICENSE",
            Error::Drift(_) => "LIFTOFF_DRIFT",
            Error::NotBaselined(_) => "LIFTOFF_NOT_BASELINED",
            Error::Git(kind, _) => match *kind {
                "push_rejected" => "LIFTOFF_GIT_PUSH_REJECTED",
                "not_a_repository" => "LIFTOFF_GIT_NOT_A_REPOSITORY",
                "no_upstream" => "LIFTOFF_GIT_NO_UPSTREAM",
                "diverged" => "LIFTOFF_GIT_DIVERGED",
                "auth" => "LIFTOFF_GIT_AUTH",
                _ => "LIFTOFF_GIT",
            },
            Error::Db(_) => "LIFTOFF_DB",
            Error::Io(_) => "LIFTOFF_IO",
        }
    }

    pub fn report(&self) -> ErrorReport {
        ErrorReport { code: self.code(), exit_code: self.exit_code(), message: self.to_string() }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorReport {
    pub code: &'static str,
    pub exit_code: i32,
    pub message: String,
}

pub(crate) fn config<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error::Config(msg.into()))
}
