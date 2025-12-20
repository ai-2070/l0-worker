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
}

impl HealthChecker {
    /// Create a new health checker
    pub fn new(timeout: Duration) -> Self {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
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
            debug!(
                port = port,
                attempt = attempt,
                max = max_attempts,
                "Waiting for worker to be healthy"
            );

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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_status(state: &str, available_slots: u32) -> WorkerStatus {
        WorkerStatus {
            worker_id: "test-1".to_string(),
            state: state.to_string(),
            protocol_version: "1.0.0".to_string(),
            max_concurrency: 64,
            inflight: 0,
            available_slots,
            uptime_ms: 1000,
            ts: 0,
        }
    }

    #[test]
    fn test_worker_status_is_accepting() {
        assert!(make_status("READY", 64).is_accepting());
        assert!(make_status("ACCEPTING", 64).is_accepting());
        assert!(!make_status("DRAINING", 64).is_accepting());
        assert!(!make_status("STOPPED", 64).is_accepting());
        assert!(!make_status("", 64).is_accepting());
    }

    #[test]
    fn test_worker_status_is_draining() {
        assert!(make_status("DRAINING", 64).is_draining());
        assert!(!make_status("READY", 64).is_draining());
        assert!(!make_status("ACCEPTING", 64).is_draining());
    }

    #[test]
    fn test_worker_status_has_capacity() {
        assert!(make_status("READY", 64).has_capacity());
        assert!(make_status("READY", 1).has_capacity());
        assert!(!make_status("READY", 0).has_capacity());
    }

    #[test]
    fn test_health_check_result_is_healthy() {
        let healthy = HealthCheckResult::Healthy(make_status("READY", 64));
        let unhealthy = HealthCheckResult::Unhealthy("error".to_string());
        let unreachable = HealthCheckResult::Unreachable("timeout".to_string());

        assert!(healthy.is_healthy());
        assert!(!unhealthy.is_healthy());
        assert!(!unreachable.is_healthy());
    }

    #[test]
    fn test_worker_status_json_parsing() {
        let json = r#"{
            "workerId": "l0-1",
            "state": "READY",
            "protocolVersion": "1.0.0",
            "maxConcurrency": 64,
            "inflight": 5,
            "availableSlots": 59,
            "uptimeMs": 12345,
            "ts": 1234567890
        }"#;

        let status: WorkerStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status.worker_id, "l0-1");
        assert_eq!(status.state, "READY");
        assert_eq!(status.max_concurrency, 64);
        assert_eq!(status.inflight, 5);
        assert_eq!(status.available_slots, 59);
        assert!(status.is_accepting());
        assert!(status.has_capacity());
    }

    #[test]
    fn test_worker_status_json_parsing_minimal() {
        // Test with only required fields (protocol_version and uptime_ms have defaults)
        let json = r#"{
            "workerId": "l0-1",
            "state": "READY",
            "maxConcurrency": 64,
            "inflight": 0,
            "availableSlots": 64,
            "ts": 0
        }"#;

        let status: WorkerStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status.worker_id, "l0-1");
        assert_eq!(status.protocol_version, ""); // default
        assert_eq!(status.uptime_ms, 0); // default
    }
}
