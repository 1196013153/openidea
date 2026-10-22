//! Services tool window › Docker (`ide-docker`).

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_docker::{ComposeOp, ContainerOp, DockerEvent, DockerLogLine, DockerObject, DockerSnapshot, PruneTarget};
use tauri::State;
use tauri::ipc::Channel;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Runs a cancellable docker command (`request` → `cancel_request`) off the command threads.
async fn cancellable<T: Send + 'static>(
    state: &AppState,
    request: RequestId,
    f: impl FnOnce(&ide_core::CancellationToken) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    let cancel = state.begin_request(request);
    let result = blocking(move || f(&cancel)).await;
    state.end_request(request);
    result
}

/// Availability plus containers, images, volumes and networks.
#[tauri::command]
#[specta::specta]
pub async fn docker_snapshot() -> IdeResult<DockerSnapshot> {
    blocking(|| Ok(ide_docker::snapshot())).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_container_op(ids: Vec<String>, op: ContainerOp) -> IdeResult<()> {
    blocking(move || ide_docker::container_op(&ids, op)).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_remove(object: DockerObject, ids: Vec<String>, force: bool) -> IdeResult<()> {
    blocking(move || ide_docker::remove(object, &ids, force)).await
}

/// Pretty-printed `docker inspect` JSON.
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect(object: DockerObject, id: String) -> IdeResult<String> {
    blocking(move || ide_docker::inspect(object, &id)).await
}

/// Streams a container's log lines until it stops or the request is cancelled.
#[tauri::command]
#[specta::specta]
pub async fn docker_logs(
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    tail: u32,
    follow: bool,
    timestamps: bool,
    on_line: Channel<DockerLogLine>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::logs(&id, tail, follow, timestamps, cancel, &|line| {
            let _ = on_line.send(line);
        })
    })
    .await
}

/// Follows `docker events` until the daemon goes away or the request is cancelled.
#[tauri::command]
#[specta::specta]
pub async fn docker_events(
    state: State<'_, AppState>,
    request: RequestId,
    on_event: Channel<DockerEvent>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::watch_events(cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_pull(
    state: State<'_, AppState>,
    request: RequestId,
    reference: String,
    on_output: Channel<String>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::pull(&reference, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_prune(
    state: State<'_, AppState>,
    request: RequestId,
    target: PruneTarget,
    on_output: Channel<String>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::prune(target, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}

/// `docker compose` start / stop / restart / down of a project found through labels.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn docker_compose_op(
    state: State<'_, AppState>,
    request: RequestId,
    project: String,
    files: Vec<String>,
    working_dir: Option<String>,
    op: ComposeOp,
    on_output: Channel<String>,
) -> IdeResult<()> {
    cancellable(&state, request, move |cancel| {
        ide_docker::compose_op(&project, &files, working_dir.as_deref(), op, cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await
}
