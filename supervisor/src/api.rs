use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures::stream::Stream;
use serde::Serialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{broadcast, RwLock};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::pool::{PoolError, PoolEvent, WorkerPool, WorkerStatus};

/// Convert PoolError to HTTP status code
fn pool_error_to_status(err: &PoolError) -> StatusCode {
    match err {
        PoolError::NotFound(_) => StatusCode::NOT_FOUND,
        PoolError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Workers list response
#[derive(Debug, Serialize)]
pub struct WorkersResponse {
    pub workers: Vec<WorkerStatus>,
    pub healthy_count: usize,
    pub total_count: usize,
}

/// Spawn response
#[derive(Debug, Serialize)]
pub struct SpawnResponse {
    pub id: String,
    pub port: u16,
}

/// Generic operation response
#[derive(Debug, Serialize)]
pub struct OperationResponse {
    pub success: bool,
    pub message: String,
}

/// Error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Shared state for the API
#[derive(Clone)]
pub struct AppState {
    pub pool: Arc<RwLock<WorkerPool>>,
    pub event_tx: broadcast::Sender<PoolEvent>,
}

/// GET /workers - Get status of all workers
async fn list_workers(State(state): State<AppState>) -> Json<WorkersResponse> {
    let pool = state.pool.read().await;
    let workers = pool.get_workers_status();
    let healthy_count = pool.healthy_count();
    let total_count = workers.len();

    Json(WorkersResponse {
        workers,
        healthy_count,
        total_count,
    })
}

/// GET /workers/:id - Get status of a single worker
async fn get_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<WorkerStatus>, (StatusCode, Json<ErrorResponse>)> {
    let pool = state.pool.read().await;
    let workers = pool.get_workers_status();

    workers
        .into_iter()
        .find(|w| w.id == id)
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Worker {} not found", id),
                }),
            )
        })
}

/// POST /workers/spawn - Spawn a new worker
async fn spawn_worker(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<SpawnResponse>), (StatusCode, Json<ErrorResponse>)> {
    let mut pool = state.pool.write().await;

    match pool.spawn_new_worker().await {
        Ok((id, port)) => Ok((StatusCode::CREATED, Json(SpawnResponse { id, port }))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )),
    }
}

/// POST /workers/:id/drain - Gracefully drain a worker
async fn drain_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<OperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut pool = state.pool.write().await;

    match pool.drain_worker(&id).await {
        Ok(()) => Ok(Json(OperationResponse {
            success: true,
            message: format!("Worker {} drain initiated", id),
        })),
        Err(e) => Err((
            pool_error_to_status(&e),
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )),
    }
}

/// POST /workers/:id/kill - Force kill a worker
async fn kill_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<OperationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut pool = state.pool.write().await;

    match pool.kill_worker(&id).await {
        Ok(()) => Ok(Json(OperationResponse {
            success: true,
            message: format!("Worker {} killed", id),
        })),
        Err(e) => Err((
            pool_error_to_status(&e),
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )),
    }
}

/// POST /workers/:id/restart - Restart a worker (drain + spawn)
async fn restart_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SpawnResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut pool = state.pool.write().await;

    match pool.restart_worker(&id).await {
        Ok((new_id, port)) => Ok(Json(SpawnResponse { id: new_id, port })),
        Err(e) => Err((
            pool_error_to_status(&e),
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )),
    }
}

/// SSE event data
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum EventData {
    WorkerHealthy { id: String, port: u16 },
    WorkerUnhealthy { id: String, reason: String },
    WorkerRestarting { id: String, attempt: u32 },
    WorkerFailed { id: String },
    AllWorkersHealthy {},
    ShuttingDown {},
}

/// GET /workers/events - SSE stream of pool events
async fn get_worker_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(event) => {
            let (event_type, data) = match event {
                PoolEvent::WorkerHealthy { worker_id, port } => (
                    "worker_healthy",
                    EventData::WorkerHealthy {
                        id: worker_id,
                        port,
                    },
                ),
                PoolEvent::WorkerUnhealthy { worker_id, reason } => (
                    "worker_unhealthy",
                    EventData::WorkerUnhealthy {
                        id: worker_id,
                        reason,
                    },
                ),
                PoolEvent::WorkerRestarting { worker_id, attempt } => (
                    "worker_restarting",
                    EventData::WorkerRestarting {
                        id: worker_id,
                        attempt,
                    },
                ),
                PoolEvent::WorkerFailed { worker_id } => {
                    ("worker_failed", EventData::WorkerFailed { id: worker_id })
                }
                PoolEvent::AllWorkersHealthy => {
                    ("all_workers_healthy", EventData::AllWorkersHealthy {})
                }
                PoolEvent::ShuttingDown => ("shutting_down", EventData::ShuttingDown {}),
            };
            let json = serde_json::to_string(&data).unwrap_or_default();
            Some(Ok(Event::default().event(event_type).data(json)))
        }
        Err(_) => None, // Lagged, skip
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// Create the API router
pub fn create_router(state: AppState) -> Router {
    Router::new()
        // List and events
        .route("/workers", get(list_workers))
        .route("/workers/events", get(get_worker_events))
        // Spawn new worker
        .route("/workers/spawn", post(spawn_worker))
        // Single worker operations
        .route("/workers/{id}", get(get_worker))
        .route("/workers/{id}/drain", post(drain_worker))
        .route("/workers/{id}/kill", post(kill_worker))
        .route("/workers/{id}/restart", post(restart_worker))
        .with_state(state)
}

/// Start the API server
pub async fn start_server(state: AppState, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let app = create_router(state);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

    tracing::info!(port = port, "Starting supervisor API server");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
