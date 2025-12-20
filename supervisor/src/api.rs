use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::pool::{WorkerPool, WorkerStatus};

/// Pool status response
#[derive(Debug, Serialize)]
pub struct PoolStatusResponse {
    pub workers: Vec<WorkerStatus>,
    pub healthy_count: usize,
    pub total_count: usize,
}

/// Shared state for the API
pub type SharedPool = Arc<RwLock<WorkerPool>>;

/// GET /api/pool - Get status of all workers
async fn get_pool_status(State(pool): State<SharedPool>) -> Json<PoolStatusResponse> {
    let pool = pool.read().await;
    let workers = pool.get_workers_status();
    let healthy_count = pool.healthy_count();
    let total_count = workers.len();

    Json(PoolStatusResponse {
        workers,
        healthy_count,
        total_count,
    })
}

/// Create the API router
pub fn create_router(pool: SharedPool) -> Router {
    Router::new()
        .route("/api/pool", get(get_pool_status))
        .with_state(pool)
}

/// Start the API server
pub async fn start_server(pool: SharedPool, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let app = create_router(pool);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

    tracing::info!(port = port, "Starting supervisor API server");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
