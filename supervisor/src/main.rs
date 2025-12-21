mod api;
mod health;
mod pool;
mod worker;

use api::AppState;
use clap::Parser;
use pool::{PoolConfig, PoolEvent, WorkerPool};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{error, info, warn, Level};
use tracing_subscriber::FmtSubscriber;

/// L0 Worker Supervisor
///
/// Process supervisor for L0 worker pool. Manages multiple worker processes,
/// monitors health, and automatically restarts failed workers.
#[derive(Parser, Debug)]
#[command(name = "l0-supervisor")]
#[command(version, about, long_about = None)]
struct Args {
    /// Number of worker processes to spawn
    #[arg(short, long, default_value_t = num_cpus::get())]
    workers: usize,

    /// Starting port for workers (workers use sequential ports)
    #[arg(short = 'p', long, default_value_t = 3001)]
    base_port: u16,

    /// Port for supervisor API server
    #[arg(long, default_value_t = 9000)]
    api_port: u16,

    /// Health check interval in milliseconds
    #[arg(long, default_value_t = 2000)]
    health_interval: u64,

    /// Health check timeout in milliseconds
    #[arg(long, default_value_t = 2000)]
    health_timeout: u64,

    /// Initial restart delay in milliseconds
    #[arg(long, default_value_t = 500)]
    restart_delay: u64,

    /// Maximum restart delay in milliseconds (exponential backoff cap)
    #[arg(long, default_value_t = 30000)]
    max_restart_delay: u64,

    /// Graceful shutdown timeout in milliseconds
    #[arg(long, default_value_t = 30000)]
    shutdown_timeout: u64,

    /// Maximum consecutive failures before giving up on a worker
    #[arg(long, default_value_t = 5)]
    max_failures: u32,

    /// Maximum consecutive unhealthy health checks before killing a worker
    #[arg(long, default_value_t = 2)]
    max_unhealthy_checks: u32,

    /// Maximum port number allowed for worker allocation.
    /// Defaults to 49151 (end of registered ports range).
    /// Set higher (up to 65535) to allow ephemeral ports.
    #[arg(long, default_value_t = 49151)]
    max_port: u16,

    /// Path to l0-worker binary
    #[arg(long, default_value = "./l0-worker")]
    worker_binary: PathBuf,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    log_level: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Initialize logging
    let log_level = match args.log_level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(false)
        .compact()
        .init();

    info!(
        workers = args.workers,
        base_port = args.base_port,
        binary = %args.worker_binary.display(),
        "Starting L0 Supervisor"
    );

    // Check if worker binary exists
    if !args.worker_binary.exists() {
        error!(
            path = %args.worker_binary.display(),
            "Worker binary not found"
        );
        std::process::exit(1);
    }

    // Create pool configuration
    let config = PoolConfig {
        worker_count: args.workers,
        base_port: args.base_port,
        binary_path: args.worker_binary,
        health_interval: Duration::from_millis(args.health_interval),
        health_timeout: Duration::from_millis(args.health_timeout),
        restart_delay: Duration::from_millis(args.restart_delay),
        max_restart_delay: Duration::from_millis(args.max_restart_delay),
        max_consecutive_failures: args.max_failures,
        max_unhealthy_checks: args.max_unhealthy_checks,
        auth_secret: std::env::var("L0_AUTH_SECRET").ok(),
        openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
        anthropic_api_key: std::env::var("ANTHROPIC_API_KEY").ok(),
        env_vars: Vec::new(),
        max_port: args.max_port,
    };

    // Create event channel for pool events
    let (pool_tx, mut pool_rx) = mpsc::channel::<PoolEvent>(32);

    // Create broadcast channel for SSE clients
    let (sse_tx, _sse_rx) = broadcast::channel::<PoolEvent>(64);

    // Create and start worker pool
    let pool = Arc::new(RwLock::new(WorkerPool::new(config, pool_tx)));

    {
        let mut pool_guard = pool.write().await;
        if let Err(e) = pool_guard.start().await {
            error!(error = %e, "Failed to start worker pool");
            std::process::exit(1);
        }
    }

    // Spawn pool event handler - logs and broadcasts to SSE clients
    let sse_tx_clone = sse_tx.clone();
    let event_handler = tokio::spawn(async move {
        while let Some(event) = pool_rx.recv().await {
            // Log the event
            match &event {
                PoolEvent::SupervisorReady {
                    worker_count,
                    api_port,
                } => {
                    info!(
                        worker_count = worker_count,
                        api_port = api_port,
                        "Supervisor ready"
                    );
                }
                PoolEvent::WorkerSpawned { worker_id, port } => {
                    info!(worker_id = %worker_id, port = port, "Worker spawned");
                }
                PoolEvent::WorkerHealthy { worker_id, port } => {
                    info!(worker_id = %worker_id, port = port, "Worker healthy");
                }
                PoolEvent::WorkerUnhealthy { worker_id, reason } => {
                    warn!(worker_id = %worker_id, reason = %reason, "Worker unhealthy");
                }
                PoolEvent::WorkerDraining { worker_id } => {
                    info!(worker_id = %worker_id, "Worker draining");
                }
                PoolEvent::WorkerDrained { worker_id } => {
                    info!(worker_id = %worker_id, "Worker drained");
                }
                PoolEvent::WorkerRestarting { worker_id, attempt } => {
                    info!(worker_id = %worker_id, attempt = attempt, "Worker restarting");
                }
                PoolEvent::WorkerFailed { worker_id } => {
                    error!(worker_id = %worker_id, "Worker failed permanently");
                }
                PoolEvent::AllWorkersHealthy => {
                    info!("All workers healthy and ready");
                }
                PoolEvent::ShuttingDown => {
                    info!("Pool shutting down");
                }
            }

            // Broadcast to SSE clients (ignore if no subscribers)
            let _ = sse_tx_clone.send(event);
        }
    });

    // Start API server with ready signal
    let api_state = AppState {
        pool: Arc::clone(&pool),
        event_tx: sse_tx.clone(),
    };
    let api_port = args.api_port;
    let worker_count = args.workers;
    let (api_ready_tx, api_ready_rx) = tokio::sync::oneshot::channel();
    let api_server = tokio::spawn(async move {
        if let Err(e) = api::start_server(api_state, api_port, Some(api_ready_tx)).await {
            error!(error = %e, "API server error");
        }
    });

    // Wait for API server to be ready before emitting supervisor_ready event
    // This ensures SSE clients can connect and receive the event
    if api_ready_rx.await.is_err() {
        error!("API server failed to start");
        std::process::exit(1);
    }
    let _ = sse_tx.send(PoolEvent::SupervisorReady {
        worker_count,
        api_port,
    });

    // Handle shutdown signals
    let shutdown_timeout = Duration::from_millis(args.shutdown_timeout);

    // Health check interval
    let health_interval = Duration::from_millis(args.health_interval);
    let poll_interval = Duration::from_millis(50); // Short poll for events

    tokio::select! {
        _ = async {
            let mut health_ticker = tokio::time::interval(health_interval);
            health_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    // Health check timer
                    _ = health_ticker.tick() => {
                        pool.write().await.do_health_check().await;
                    }

                    // Poll for events frequently (short lock hold)
                    _ = tokio::time::sleep(poll_interval) => {
                        // Process all pending events
                        while pool.write().await.try_recv_event().await {}
                    }
                }
            }
        } => {
            // Pool run exited (shouldn't happen normally)
            warn!("Pool run exited unexpectedly");
        }

        _ = tokio::signal::ctrl_c() => {
            info!("Received SIGINT, initiating graceful shutdown");
            pool.write().await.shutdown(shutdown_timeout).await;
        }

        _ = async {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sigterm = signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
                sigterm.recv().await;
            }
            #[cfg(not(unix))]
            {
                std::future::pending::<()>().await;
            }
        } => {
            info!("Received SIGTERM, initiating graceful shutdown");
            pool.write().await.shutdown(shutdown_timeout).await;
        }
    }

    // Wait for event handler to finish
    event_handler.abort();
    api_server.abort();

    info!("Supervisor exiting");
    Ok(())
}
