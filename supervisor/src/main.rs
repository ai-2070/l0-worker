mod health;
mod pool;
mod worker;

use clap::Parser;
use pool::{PoolConfig, PoolEvent, WorkerPool};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
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

    /// Health check interval in milliseconds
    #[arg(long, default_value_t = 5000)]
    health_interval: u64,

    /// Initial restart delay in milliseconds
    #[arg(long, default_value_t = 1000)]
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
        restart_delay: Duration::from_millis(args.restart_delay),
        max_restart_delay: Duration::from_millis(args.max_restart_delay),
        max_consecutive_failures: args.max_failures,
        auth_secret: std::env::var("L0_AUTH_SECRET").ok(),
        openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
        anthropic_api_key: std::env::var("ANTHROPIC_API_KEY").ok(),
        env_vars: Vec::new(),
    };

    // Create event channel for pool events
    let (pool_tx, mut pool_rx) = mpsc::channel::<PoolEvent>(32);

    // Create and start worker pool
    let mut pool = WorkerPool::new(config, pool_tx);

    if let Err(e) = pool.start().await {
        error!(error = %e, "Failed to start worker pool");
        std::process::exit(1);
    }

    // Spawn pool event handler
    let event_handler = tokio::spawn(async move {
        while let Some(event) = pool_rx.recv().await {
            match event {
                PoolEvent::WorkerHealthy { worker_id, port } => {
                    info!(worker_id = %worker_id, port = port, "Worker healthy");
                }
                PoolEvent::WorkerUnhealthy { worker_id, reason } => {
                    warn!(worker_id = %worker_id, reason = %reason, "Worker unhealthy");
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
        }
    });

    // Handle shutdown signals
    let shutdown_timeout = Duration::from_millis(args.shutdown_timeout);

    tokio::select! {
        _ = pool.run() => {
            // Pool run exited (shouldn't happen normally)
            warn!("Pool run exited unexpectedly");
        }

        _ = tokio::signal::ctrl_c() => {
            info!("Received SIGINT, initiating graceful shutdown");
            pool.shutdown(shutdown_timeout).await;
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
            pool.shutdown(shutdown_timeout).await;
        }
    }

    // Wait for event handler to finish
    event_handler.abort();

    info!("Supervisor exiting");
    Ok(())
}
