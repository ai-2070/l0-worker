#![allow(dead_code)]

use crate::health::{HealthCheckResult, HealthChecker};
use crate::worker::{Worker, WorkerConfig, WorkerEvent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Worker state in the pool
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerState {
    /// Worker is starting up
    Starting,
    /// Worker is healthy and accepting tasks
    Healthy,
    /// Worker is draining (graceful shutdown)
    Draining,
    /// Worker has failed and is waiting for restart
    Failed { restart_at: Instant },
    /// Worker is stopped
    Stopped,
}

/// Managed worker entry
struct ManagedWorker {
    worker: Worker,
    state: WorkerState,
    consecutive_failures: u32,
    last_healthy: Option<Instant>,
}

/// Configuration for the worker pool
#[derive(Debug, Clone)]
pub struct PoolConfig {
    pub worker_count: usize,
    pub base_port: u16,
    pub binary_path: PathBuf,
    pub health_interval: Duration,
    pub restart_delay: Duration,
    pub max_restart_delay: Duration,
    pub max_consecutive_failures: u32,
    pub auth_secret: Option<String>,
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub env_vars: Vec<(String, String)>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            worker_count: num_cpus::get(),
            base_port: 3001,
            binary_path: PathBuf::from("./l0-worker"),
            health_interval: Duration::from_secs(5),
            restart_delay: Duration::from_secs(1),
            max_restart_delay: Duration::from_secs(30),
            max_consecutive_failures: 5,
            auth_secret: None,
            openai_api_key: None,
            anthropic_api_key: None,
            env_vars: Vec::new(),
        }
    }
}

/// Events emitted by the worker pool
#[derive(Debug, Clone)]
pub enum PoolEvent {
    /// A worker became healthy
    WorkerHealthy { worker_id: String, port: u16 },
    /// A worker became unhealthy
    WorkerUnhealthy { worker_id: String, reason: String },
    /// A worker is being restarted
    WorkerRestarting { worker_id: String, attempt: u32 },
    /// A worker failed permanently (too many restarts)
    WorkerFailed { worker_id: String },
    /// All workers are healthy
    AllWorkersHealthy,
    /// Pool is shutting down
    ShuttingDown,
}

/// Worker pool manager
pub struct WorkerPool {
    config: PoolConfig,
    workers: HashMap<String, ManagedWorker>,
    health_checker: HealthChecker,
    event_tx: mpsc::Sender<WorkerEvent>,
    event_rx: mpsc::Receiver<WorkerEvent>,
    pool_event_tx: mpsc::Sender<PoolEvent>,
}

impl WorkerPool {
    /// Create a new worker pool
    pub fn new(config: PoolConfig, pool_event_tx: mpsc::Sender<PoolEvent>) -> Self {
        let (event_tx, event_rx) = mpsc::channel(100);
        let health_checker = HealthChecker::new(Duration::from_secs(5));

        Self {
            config,
            workers: HashMap::new(),
            health_checker,
            event_tx,
            event_rx,
            pool_event_tx,
        }
    }

    /// Start all workers
    pub async fn start(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        info!(
            count = self.config.worker_count,
            base_port = self.config.base_port,
            binary = %self.config.binary_path.display(),
            "Starting worker pool"
        );

        for i in 0..self.config.worker_count {
            let port = self.config.base_port + i as u16;
            let worker_id = format!("l0-{}", i + 1);

            self.spawn_worker(&worker_id, port).await?;
        }

        Ok(())
    }

    /// Spawn a single worker
    async fn spawn_worker(
        &mut self,
        worker_id: &str,
        port: u16,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let config = WorkerConfig {
            binary_path: self.config.binary_path.clone(),
            port,
            worker_id: worker_id.to_string(),
            auth_secret: self.config.auth_secret.clone(),
            openai_api_key: self.config.openai_api_key.clone(),
            anthropic_api_key: self.config.anthropic_api_key.clone(),
            env_vars: self.config.env_vars.clone(),
        };

        let mut worker = Worker::new(config, self.event_tx.clone());
        worker.spawn().await?;

        self.workers.insert(
            worker_id.to_string(),
            ManagedWorker {
                worker,
                state: WorkerState::Starting,
                consecutive_failures: 0,
                last_healthy: None,
            },
        );

        Ok(())
    }

    /// Run the pool's event loop
    pub async fn run(&mut self) {
        let mut health_interval = tokio::time::interval(self.config.health_interval);

        loop {
            tokio::select! {
                // Handle worker events
                Some(event) = self.event_rx.recv() => {
                    self.handle_worker_event(event).await;
                }

                // Periodic health checks
                _ = health_interval.tick() => {
                    self.check_all_health().await;
                    self.process_restarts().await;
                }
            }
        }
    }

    /// Handle a worker event
    async fn handle_worker_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Ready { port, worker_id } => {
                info!(worker_id = %worker_id, port = port, "Worker ready");

                if let Some(managed) = self.workers.get_mut(&worker_id) {
                    managed.state = WorkerState::Healthy;
                    managed.consecutive_failures = 0;
                    managed.last_healthy = Some(Instant::now());
                }

                let _ = self
                    .pool_event_tx
                    .send(PoolEvent::WorkerHealthy { worker_id, port })
                    .await;

                // Check if all workers are healthy
                if self.all_workers_healthy() {
                    let _ = self.pool_event_tx.send(PoolEvent::AllWorkersHealthy).await;
                }
            }

            WorkerEvent::Draining { worker_id } => {
                info!(worker_id = %worker_id, "Worker draining");

                if let Some(managed) = self.workers.get_mut(&worker_id) {
                    managed.state = WorkerState::Draining;
                }
            }

            WorkerEvent::Exited { exit_code } => {
                // Find which worker exited
                let mut exited_worker: Option<(String, u32)> = None;

                for (worker_id, managed) in &mut self.workers {
                    if !managed.worker.is_running() && managed.state != WorkerState::Stopped {
                        if exit_code == Some(0) {
                            info!(worker_id = %worker_id, "Worker exited cleanly");
                            managed.state = WorkerState::Stopped;
                        } else {
                            warn!(
                                worker_id = %worker_id,
                                exit_code = ?exit_code,
                                "Worker crashed"
                            );

                            managed.consecutive_failures += 1;
                            let failures = managed.consecutive_failures;

                            // Calculate restart delay with exponential backoff
                            let delay = Self::calculate_restart_delay_static(
                                &self.config,
                                failures,
                            );
                            managed.state = WorkerState::Failed {
                                restart_at: Instant::now() + delay,
                            };

                            exited_worker = Some((worker_id.clone(), failures));
                        }
                        break;
                    }
                }

                // Send events outside the borrow
                if let Some((worker_id, failures)) = exited_worker {
                    let _ = self
                        .pool_event_tx
                        .send(PoolEvent::WorkerUnhealthy {
                            worker_id: worker_id.clone(),
                            reason: format!("Exit code: {:?}", exit_code),
                        })
                        .await;

                    if failures <= self.config.max_consecutive_failures {
                        let _ = self
                            .pool_event_tx
                            .send(PoolEvent::WorkerRestarting {
                                worker_id: worker_id.clone(),
                                attempt: failures,
                            })
                            .await;
                    } else {
                        error!(
                            worker_id = %worker_id,
                            failures = failures,
                            "Worker exceeded max restart attempts"
                        );
                        let _ = self
                            .pool_event_tx
                            .send(PoolEvent::WorkerFailed { worker_id })
                            .await;
                    }
                }
            }

            WorkerEvent::Stdout(line) => {
                debug!(line = %line, "Worker stdout");
            }

            WorkerEvent::Stderr(line) => {
                warn!(line = %line, "Worker stderr");
            }
        }
    }

    /// Check health of all workers
    async fn check_all_health(&mut self) {
        let ports: Vec<(String, u16)> = self
            .workers
            .iter()
            .filter(|(_, m)| m.state == WorkerState::Healthy || m.state == WorkerState::Starting)
            .map(|(id, m)| (id.clone(), m.worker.port()))
            .collect();

        for (worker_id, port) in ports {
            let result = self.health_checker.check(port).await;

            match result {
                HealthCheckResult::Healthy(_status) => {
                    if let Some(managed) = self.workers.get_mut(&worker_id) {
                        if managed.state == WorkerState::Starting {
                            managed.state = WorkerState::Healthy;
                            managed.last_healthy = Some(Instant::now());

                            let _ = self
                                .pool_event_tx
                                .send(PoolEvent::WorkerHealthy {
                                    worker_id: worker_id.clone(),
                                    port,
                                })
                                .await;
                        } else {
                            managed.last_healthy = Some(Instant::now());
                        }
                    }
                }

                HealthCheckResult::Unhealthy(reason) | HealthCheckResult::Unreachable(reason) => {
                    if let Some(managed) = self.workers.get_mut(&worker_id) {
                        // Check if the worker process is still running
                        let is_running = managed.worker.is_running();

                        if managed.state == WorkerState::Healthy {
                            warn!(
                                worker_id = %worker_id,
                                reason = %reason,
                                is_running = is_running,
                                "Worker became unhealthy"
                            );
                        }

                        // If worker process crashed, schedule restart
                        if !is_running && !matches!(managed.state, WorkerState::Failed { .. }) && managed.state != WorkerState::Stopped {
                            warn!(
                                worker_id = %worker_id,
                                "Worker process exited, scheduling restart"
                            );

                            managed.consecutive_failures += 1;
                            let failures = managed.consecutive_failures;

                            if failures <= self.config.max_consecutive_failures {
                                let delay = Self::calculate_restart_delay_static(
                                    &self.config,
                                    failures,
                                );
                                managed.state = WorkerState::Failed {
                                    restart_at: Instant::now() + delay,
                                };

                                let _ = self
                                    .pool_event_tx
                                    .send(PoolEvent::WorkerRestarting {
                                        worker_id: worker_id.clone(),
                                        attempt: failures,
                                    })
                                    .await;
                            } else {
                                managed.state = WorkerState::Stopped;
                                error!(
                                    worker_id = %worker_id,
                                    failures = failures,
                                    "Worker exceeded max restart attempts"
                                );
                                let _ = self
                                    .pool_event_tx
                                    .send(PoolEvent::WorkerFailed {
                                        worker_id: worker_id.clone(),
                                    })
                                    .await;
                            }
                        }
                    }
                }
            }
        }
    }

    /// Process pending restarts
    async fn process_restarts(&mut self) {
        let now = Instant::now();
        let mut to_restart: Vec<(String, u16)> = Vec::new();

        for (worker_id, managed) in &self.workers {
            if let WorkerState::Failed { restart_at } = managed.state {
                if now >= restart_at
                    && managed.consecutive_failures <= self.config.max_consecutive_failures
                {
                    to_restart.push((worker_id.clone(), managed.worker.port()));
                }
            }
        }

        for (worker_id, port) in to_restart {
            info!(worker_id = %worker_id, port = port, "Restarting worker");

            // Remove old worker
            self.workers.remove(&worker_id);

            // Spawn new worker
            if let Err(e) = self.spawn_worker(&worker_id, port).await {
                error!(worker_id = %worker_id, error = %e, "Failed to restart worker");
            }
        }
    }

    /// Calculate restart delay with exponential backoff (static version for borrow checker)
    fn calculate_restart_delay_static(config: &PoolConfig, failures: u32) -> Duration {
        let delay_ms = config.restart_delay.as_millis() as u64 * 2u64.pow(failures.saturating_sub(1));
        let max_ms = config.max_restart_delay.as_millis() as u64;
        Duration::from_millis(delay_ms.min(max_ms))
    }

    /// Check if all workers are healthy
    fn all_workers_healthy(&self) -> bool {
        self.workers
            .values()
            .all(|m| m.state == WorkerState::Healthy)
    }

    /// Gracefully shut down all workers
    pub async fn shutdown(&mut self, timeout: Duration) {
        info!("Shutting down worker pool");
        let _ = self.pool_event_tx.send(PoolEvent::ShuttingDown).await;

        // Send SIGTERM to all workers
        for (worker_id, managed) in &mut self.workers {
            if managed.worker.is_running() {
                if let Err(e) = managed.worker.terminate().await {
                    warn!(worker_id = %worker_id, error = %e, "Failed to terminate worker");
                }
            }
        }

        // Wait for workers to exit
        let deadline = Instant::now() + timeout;

        while Instant::now() < deadline {
            let all_stopped = self
                .workers
                .values_mut()
                .all(|m| !m.worker.is_running());

            if all_stopped {
                info!("All workers stopped");
                return;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Force kill remaining workers
        warn!("Timeout waiting for workers, force killing");
        for (worker_id, managed) in &mut self.workers {
            if managed.worker.is_running() {
                if let Err(e) = managed.worker.kill().await {
                    error!(worker_id = %worker_id, error = %e, "Failed to kill worker");
                }
            }
        }
    }

    /// Get the count of healthy workers
    pub fn healthy_count(&self) -> usize {
        self.workers
            .values()
            .filter(|m| m.state == WorkerState::Healthy)
            .count()
    }

    /// Get all worker ports
    pub fn worker_ports(&self) -> Vec<u16> {
        self.workers.values().map(|m| m.worker.port()).collect()
    }
}
