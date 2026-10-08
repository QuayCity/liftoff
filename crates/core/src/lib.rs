//! LiftOff core: everything the CLI and the desktop app do, implemented once.

pub mod checks;
pub mod ci;
pub mod config;
pub mod db;
pub mod diff;
pub mod error;
pub mod flyway;
pub mod git;
pub mod license;
pub mod migration;
pub mod mssql;
pub mod model;
pub mod runner;

pub use error::{Error, Result};
