//! Logging: stdout (as before) plus a daily-rotated file in the app log dir
//! (`~/Library/Logs/<identifier>` on macOS, `<local data>/<identifier>/logs`
//! elsewhere — the same place as Tauri's `app_log_dir`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const PREFIX: &str = "openidea";
const SUFFIX: &str = "log";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

pub fn log_dir_for(identifier: &str) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(identifier))
    } else {
        dirs::data_local_dir().map(|d| d.join(identifier).join("logs"))
    }
}

fn filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,openidea_lib=debug".into())
}

pub fn init(identifier: &str) {
    let stdout = tracing_subscriber::fmt::layer().with_filter(filter());
    let file = log_dir_for(identifier).and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(PREFIX)
            .filename_suffix(SUFFIX)
            .max_log_files(7)
            .build(&dir)
            .ok()?;
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let _ = GUARD.set(guard);
        let _ = LOG_DIR.set(dir);
        Some(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer).with_filter(filter()))
    });
    let _ = tracing_subscriber::registry().with(stdout).with(file).try_init();
}

pub fn log_dir() -> Option<&'static Path> {
    LOG_DIR.get().map(PathBuf::as_path)
}

/// The most recently modified log file in `dir`.
pub fn latest_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(PREFIX))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_log_picks_newest_matching_file() {
        let dir = std::env::temp_dir().join(format!("openidea-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other.txt"), "x").unwrap();
        assert_eq!(latest_log(&dir), None);
        std::fs::write(dir.join("openidea.2026-01-01.log"), "x").unwrap();
        assert_eq!(latest_log(&dir), Some(dir.join("openidea.2026-01-01.log")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn log_dir_is_per_identifier() {
        let d = log_dir_for("com.example.x").unwrap();
        assert!(d.to_string_lossy().contains("com.example.x"));
    }
}
