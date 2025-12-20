#![allow(dead_code)]

use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tracing::{debug, warn};

/// Worker health status from /api/status endpoint
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatus {
    pub worker_id: String,
    pub state: String,
    #[serde(default)]
    pub protocol_version: String,
    pub max_concurrency: u32,
    pub inflight: u32,
    pub available_slots: u32,
    #[serde(default)]
    pub uptime_ms: u64,
    pub ts: u64,
}

impl WorkerStatus {
    /// Check if worker is accepting new tasks
    pub fn is_accepting(&self) -> bool {
        self.state == "ACCEPTING" || self.state == "READY"
    }

    /// Check if worker is draining
    pub fn is_draining(&self) -> bool {
        self.state == "DRAINING"
    }

    /// Check if worker has available capacity
    pub fn has_capacity(&self) -> bool {
        self.available_slots > 0
    }
}

/// Health check result
#[derive(Debug, Clone)]
pub enum HealthCheckResult {
    /// Worker is healthy
    Healthy(WorkerStatus),
    /// Worker is unhealthy (HTTP error or bad status)
    Unhealthy(String),
    /// Worker is unreachable (connection failed)
    Unreachable(String),
}

impl HealthCheckResult {
    pub fn is_healthy(&self) -> bool {
        matches!(self, HealthCheckResult::Healthy(_))
    }
}

/// Health checker for worker endpoints
pub struct HealthChecker {
    client: Client,
    timeout: Duration,
}

impl HealthChecker {
    /// Create a new health checker
    pub fn new(timeout: Duration) -> Self {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .expect("Failed to create HTTP client");

        Self { client, timeout }
    }

    /// Check health of a worker at the given port
    pub async fn check(&self, port: u16) -> HealthCheckResult {
        let url = format!("http://127.0.0.1:{}/api/status", port);

        debug!(url = %url, "Checking worker health");

        match self.client.get(&url).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    match response.json::<WorkerStatus>().await {
                        Ok(status) => {
                            debug!(
                                worker_id = %status.worker_id,
                                state = %status.state,
                                inflight = status.inflight,
                                available = status.available_slots,
                                "Worker health check succeeded"
                            );
                            HealthCheckResult::Healthy(status)
                        }
                        Err(e) => {
                            warn!(error = %e, "Failed to parse health response");
                            HealthCheckResult::Unhealthy(format!("Invalid response: {}", e))
                        }
                    }
                } else {
                    let status_code = response.status();
                    warn!(status = %status_code, "Worker health check returned error");
                    HealthCheckResult::Unhealthy(format!("HTTP {}", status_code))
                }
            }
            Err(e) => {
                if e.is_connect() {
                    debug!(error = %e, "Worker unreachable");
                    HealthCheckResult::Unreachable(format!("Connection failed: {}", e))
                } else if e.is_timeout() {
                    warn!(error = %e, "Worker health check timed out");
                    HealthCheckResult::Unreachable(format!("Timeout: {}", e))
                } else {
                    warn!(error = %e, "Worker health check failed");
                    HealthCheckResult::Unhealthy(format!("Request failed: {}", e))
                }
            }
        }
    }

    /// Wait for a worker to become healthy with retries
    pub async fn wait_for_healthy(
        &self,
        port: u16,
        max_attempts: u32,
        retry_delay: Duration,
    ) -> Option<WorkerStatus> {
        for attempt in 1..=max_attempts {
            debug!(port = port, attempt = attempt, max = max_attempts, "Waiting for worker to be healthy");

            match self.check(port).await {
                HealthCheckResult::Healthy(status) if status.is_accepting() => {
                    return Some(status);
                }
                HealthCheckResult::Healthy(status) => {
                    debug!(state = %status.state, "Worker not yet accepting");
                }
                HealthCheckResult::Unhealthy(reason) => {
                    debug!(reason = %reason, "Worker unhealthy");
                }
                HealthCheckResult::Unreachable(reason) => {
                    debug!(reason = %reason, "Worker unreachable");
                }
            }

            if attempt < max_attempts {
                tokio::time::sleep(retry_delay).await;
            }
        }

        None
    }
}

impl Default for HealthChecker {
    fn default() -> Self {
        Self::new(Duration::from_secs(5))
    }
}
