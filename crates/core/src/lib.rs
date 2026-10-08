//! LiftOff core: everything the CLI and the desktop app do, implemented once.

pub mod config;
pub mod db;
pub mod diff;
pub mod error;
pub mod license;
pub mod migration;
pub mod runner;

pub use error::{Error, Result};
