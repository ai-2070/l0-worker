use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Json, Router,
};
use futures::stream::Stream;
use serde::Serialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{broadcast, RwLock};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::pool::{PoolEvent, WorkerPool, WorkerStatus};

/// Pool status response
#[derive(Debug, Serialize)]
pub struct PoolStatusResponse {
    pub workers: Vec<WorkerStatus>,
    pub healthy_count: usize,
    pub total_count: usize,
}

/// Shared state for the API
#[derive(Clone)]
pub struct AppState {
    pub pool: Arc<RwLock<WorkerPool>>,
    pub event_tx: broadcast::Sender<PoolEvent>,
}

/// GET /api/pool - Get status of all workers
async fn get_pool_status(State(state): State<AppState>) -> Json<PoolStatusResponse> {
    let pool = state.pool.read().await;
    let workers = pool.get_workers_status();
    let healthy_count = pool.healthy_count();
    let total_count = workers.len();

    Json(PoolStatusResponse {
        workers,
        healthy_count,
        total_count,
    })
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

/// GET /api/pool/events - SSE stream of pool events
async fn get_pool_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| {
        match result {
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
        }
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
        .route("/api/pool", get(get_pool_status))
        .route("/api/pool/events", get(get_pool_events))
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
