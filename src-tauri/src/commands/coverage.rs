//! Run with Coverage: launch plans and coverage reports.

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, IpcPath};
use ide_coverage::{CoveragePrepared, CoverageReportSpec, CoverageSuite};
use ide_run::RunConfig;
use tauri::{State, Window};

/// Output directories kept per kind (older runs' data is deleted).
pub(crate) const KEEP_RUNS: usize = 10;

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// How to run `config` with coverage: the command to launch and where its report will be,
/// or which tool is missing.
#[tauri::command]
#[specta::specta]
pub async fn coverage_prepare(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
) -> IdeResult<CoveragePrepared> {
    let project = state.project(window.label())?;
    let (root, cache) = (project.root.clone(), project.cache_dir.join("coverage"));
    blocking(move || {
        let out = ide_run::wrap::new_output_dir(&cache, KEEP_RUNS)?;
        Ok(ide_coverage::prepare(&root, &config, &out))
    })
    .await
}

/// Reads the report a coverage run left behind.
#[tauri::command]
#[specta::specta]
pub async fn coverage_collect(report: CoverageReportSpec) -> IdeResult<CoverageSuite> {
    blocking(move || ide_coverage::collect(&report)).await
}

/// Reads a report collected elsewhere (CI): lcov, a Go cover profile or JaCoCo XML,
/// with paths mapped into this project.
#[tauri::command]
#[specta::specta]
pub async fn coverage_import(window: Window, state: State<'_, AppState>, path: IpcPath) -> IdeResult<CoverageSuite> {
    let root = state.project(window.label())?.root.clone();
    blocking(move || ide_coverage::import(&path, &root)).await
}
