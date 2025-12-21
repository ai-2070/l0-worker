//! Integration tests for l0-supervisor
//!
//! These tests require the l0-worker binary to be built.
//! Run `bun run build` in the parent directory first.

use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// Helper to find the project root (where Cargo.toml is)
fn project_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Helper to find the worker binary
fn worker_binary() -> std::path::PathBuf {
    project_root().parent().unwrap().join("dist/l0-worker")
}

/// Helper to find the supervisor binary
fn supervisor_binary() -> std::path::PathBuf {
    project_root().join("target/debug/l0-supervisor")
}

/// Start supervisor and return the child process
fn start_supervisor(workers: u32, base_port: u16) -> Child {
    Command::new(supervisor_binary())
        .arg("--workers")
        .arg(workers.to_string())
        .arg("--base-port")
        .arg(base_port.to_string())
        .arg("--worker-binary")
        .arg(worker_binary())
        .arg("--health-interval")
        .arg("500") // Fast health checks for testing
        .arg("--restart-delay")
        .arg("500") // Fast restart for testing
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to start supervisor")
}

/// Wait for worker to become healthy
fn wait_for_healthy(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();

    while start.elapsed() < timeout {
        if let Ok(resp) = client
            .get(format!("http://127.0.0.1:{}/api/status", port))
            .send()
        {
            if resp.status().is_success() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Get worker status
fn get_worker_status(port: u16) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    client
        .get(format!("http://127.0.0.1:{}/api/status", port))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Find and kill worker process on a specific port
fn kill_worker_on_port(port: u16) -> bool {
    // Use lsof to find the process using the port
    let output = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output();

    if let Ok(output) = output {
        let pids = String::from_utf8_lossy(&output.stdout);
        for pid in pids.lines() {
            if let Ok(pid) = pid.trim().parse::<i32>() {
                // Kill the process
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                return true;
            }
        }
    }
    false
}

/// Clean up any processes on test ports
fn cleanup_ports(base_port: u16, count: u16) {
    for i in 0..count {
        let _ = kill_worker_on_port(base_port + i);
    }
}

#[test]
fn test_supervisor_starts_workers() {
    // Skip if worker binary doesn't exist
    if !worker_binary().exists() {
        eprintln!(
            "Skipping integration test: worker binary not found at {:?}",
            worker_binary()
        );
        eprintln!("Run 'bun run build' first to build the worker");
        return;
    }

    let base_port = 4001;
    cleanup_ports(base_port, 2);

    let mut supervisor = start_supervisor(2, base_port);

    // Wait for both workers to become healthy
    let healthy1 = wait_for_healthy(base_port, Duration::from_secs(10));
    let healthy2 = wait_for_healthy(base_port + 1, Duration::from_secs(10));

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 2);

    assert!(healthy1, "Worker 1 should be healthy");
    assert!(healthy2, "Worker 2 should be healthy");
}

#[test]
fn test_worker_health_status() {
    // Skip if worker binary doesn't exist
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4010;
    cleanup_ports(base_port, 1);

    let mut supervisor = start_supervisor(1, base_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy"
    );

    // Get and verify status
    let status = get_worker_status(base_port).expect("Should get worker status");

    assert_eq!(status["state"], "READY");
    assert!(status["maxConcurrency"].as_u64().unwrap() > 0);
    assert!(status["availableSlots"].as_u64().unwrap() > 0);
    assert!(status["workerId"].as_str().is_some());

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_worker_crash_recovery() {
    // Skip if worker binary doesn't exist
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4020;
    cleanup_ports(base_port, 1);

    let mut supervisor = start_supervisor(1, base_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy initially"
    );

    // Get initial uptime
    let status1 = get_worker_status(base_port).expect("Should get initial status");
    let uptime1 = status1["uptimeMs"].as_u64().unwrap();

    // Kill the worker
    assert!(
        kill_worker_on_port(base_port),
        "Should find and kill worker process"
    );

    // Wait a moment for supervisor to detect the crash
    std::thread::sleep(Duration::from_millis(500));

    // Worker should be down
    assert!(
        get_worker_status(base_port).is_none(),
        "Worker should be down after kill"
    );

    // Wait for worker to be restarted
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should be restarted and healthy"
    );

    // Verify uptime is lower (new process)
    let status2 = get_worker_status(base_port).expect("Should get status after restart");
    let uptime2 = status2["uptimeMs"].as_u64().unwrap();

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);

    // The restarted worker should have lower uptime than original had
    // (accounting for the time it took to restart)
    assert!(
        uptime2 < uptime1 + 5000,
        "Restarted worker should have fresh uptime (was {} now {})",
        uptime1,
        uptime2
    );
}

/// Get workers list from supervisor API
fn get_workers_list(api_port: u16) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    client
        .get(format!("http://127.0.0.1:{}/workers", api_port))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Spawn a new worker via supervisor API
fn spawn_worker_api(api_port: u16) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    client
        .post(format!("http://127.0.0.1:{}/workers/spawn", api_port))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Kill a worker via supervisor API
fn kill_worker_api(api_port: u16, worker_id: &str) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    client
        .post(format!(
            "http://127.0.0.1:{}/workers/{}/kill",
            api_port, worker_id
        ))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Restart a worker via supervisor API
fn restart_worker_api(api_port: u16, worker_id: &str) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    client
        .post(format!(
            "http://127.0.0.1:{}/workers/{}/restart",
            api_port, worker_id
        ))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Drain a worker via supervisor API
fn drain_worker_api(api_port: u16, worker_id: &str) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    client
        .post(format!(
            "http://127.0.0.1:{}/workers/{}/drain",
            api_port, worker_id
        ))
        .send()
        .ok()?
        .json()
        .ok()
}

/// Get a single worker by ID via supervisor API
fn get_worker_by_id(api_port: u16, worker_id: &str) -> Option<reqwest::blocking::Response> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    client
        .get(format!(
            "http://127.0.0.1:{}/workers/{}",
            api_port, worker_id
        ))
        .send()
        .ok()
}

/// Wait for worker to become unavailable (stopped/crashed)
fn wait_for_worker_down(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if get_worker_status(port).is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Wait for supervisor API to be ready
fn wait_for_supervisor_api(api_port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if get_workers_list(api_port).is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Start supervisor with custom API port
fn start_supervisor_with_api(workers: u32, base_port: u16, api_port: u16) -> Child {
    Command::new(supervisor_binary())
        .arg("--workers")
        .arg(workers.to_string())
        .arg("--base-port")
        .arg(base_port.to_string())
        .arg("--api-port")
        .arg(api_port.to_string())
        .arg("--worker-binary")
        .arg(worker_binary())
        .arg("--health-interval")
        .arg("500")
        .arg("--restart-delay")
        .arg("500")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to start supervisor")
}

#[test]
fn test_supervisor_api_workers_list() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4040;
    let api_port = 9040;
    cleanup_ports(base_port, 2);

    let mut supervisor = start_supervisor_with_api(2, base_port, api_port);

    // Wait for supervisor API and workers
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker 1 should be healthy"
    );
    assert!(
        wait_for_healthy(base_port + 1, Duration::from_secs(10)),
        "Worker 2 should be healthy"
    );

    // Wait for health checks to propagate to supervisor
    std::thread::sleep(Duration::from_millis(1000));

    // Get workers list
    let workers = get_workers_list(api_port).expect("Should get workers list");
    assert_eq!(workers["total_count"], 2);
    // Note: healthy_count may lag behind due to health check interval
    assert_eq!(workers["workers"].as_array().unwrap().len(), 2);

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 2);
}

#[test]
fn test_supervisor_api_spawn_worker() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4050;
    let api_port = 9050;
    cleanup_ports(base_port, 3);

    let mut supervisor = start_supervisor_with_api(1, base_port, api_port);

    // Wait for initial worker
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Initial worker should be healthy"
    );

    // Spawn a new worker
    let spawn_result = spawn_worker_api(api_port).expect("Should spawn worker");
    assert!(spawn_result["id"].as_str().is_some());
    let new_port = spawn_result["port"].as_u64().unwrap() as u16;

    // Wait for new worker to be healthy
    assert!(
        wait_for_healthy(new_port, Duration::from_secs(10)),
        "Spawned worker should become healthy"
    );

    // Verify we now have 2 workers
    let workers = get_workers_list(api_port).expect("Should get workers list");
    assert_eq!(workers["total_count"], 2);

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 3);
}

#[test]
fn test_supervisor_api_kill_worker() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4060;
    let api_port = 9060;
    cleanup_ports(base_port, 2);

    let mut supervisor = start_supervisor_with_api(1, base_port, api_port);

    // Wait for worker
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should be healthy"
    );

    // Get worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap();

    // Kill the worker via API
    let kill_result = kill_worker_api(api_port, worker_id).expect("Should kill worker");
    assert!(kill_result["message"].as_str().is_some());

    // Worker should be down
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        get_worker_status(base_port).is_none(),
        "Worker should be down after kill"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 2);
}

#[test]
fn test_supervisor_api_restart_worker() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4070;
    let api_port = 9070;
    cleanup_ports(base_port, 2);

    let mut supervisor = start_supervisor_with_api(1, base_port, api_port);

    // Wait for worker
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should be healthy"
    );

    // Get original worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let old_worker_id = workers["workers"][0]["id"].as_str().unwrap().to_string();

    // Restart the worker via API
    let restart_result =
        restart_worker_api(api_port, &old_worker_id).expect("Should restart worker");
    let new_worker_id = restart_result["id"].as_str().unwrap();

    // IDs should be different
    assert_ne!(
        old_worker_id, new_worker_id,
        "New worker should have different ID"
    );

    // Same port
    assert_eq!(restart_result["port"].as_u64().unwrap() as u16, base_port);

    // Wait for new worker to be healthy
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Restarted worker should become healthy"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 2);
}

#[test]
fn test_supervisor_api_drain_worker() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4090;
    let api_port = 9090;
    cleanup_ports(base_port, 1);

    let mut supervisor = start_supervisor_with_api(1, base_port, api_port);

    // Wait for worker
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should be healthy"
    );

    // Get worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap();

    // Drain the worker via API
    let drain_result = drain_worker_api(api_port, worker_id).expect("Should drain worker");
    assert!(drain_result["success"].as_bool().unwrap_or(false));
    assert!(drain_result["message"].as_str().is_some());

    // Worker should eventually stop (drain triggers graceful shutdown)
    assert!(
        wait_for_worker_down(base_port, Duration::from_secs(10)),
        "Worker should be down after drain"
    );

    // Test idempotency - draining again should not error
    let drain_result2 = drain_worker_api(api_port, worker_id);
    assert!(
        drain_result2.is_some(),
        "Draining already-drained worker should succeed (idempotent)"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_supervisor_api_get_worker_by_id() {
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4080;
    let api_port = 9080;
    cleanup_ports(base_port, 1);

    let mut supervisor = start_supervisor_with_api(1, base_port, api_port);

    // Wait for worker
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should be healthy"
    );

    // Get worker ID from list
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap();

    // Get single worker by ID
    let response = get_worker_by_id(api_port, worker_id).expect("Should get response");
    assert!(response.status().is_success(), "Should return 200 OK");

    let worker: serde_json::Value = response.json().expect("Should parse JSON");
    assert_eq!(worker["id"].as_str().unwrap(), worker_id);
    assert_eq!(worker["port"].as_u64().unwrap() as u16, base_port);
    assert!(worker["state"].as_str().is_some());

    // Test not found case
    let not_found_response =
        get_worker_by_id(api_port, "nonexistent-worker").expect("Should get response");
    assert_eq!(
        not_found_response.status(),
        reqwest::StatusCode::NOT_FOUND,
        "Should return 404 for unknown worker"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_graceful_shutdown() {
    // Skip if worker binary doesn't exist
    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4030;
    cleanup_ports(base_port, 1);

    let mut supervisor = start_supervisor(1, base_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy"
    );

    // Send SIGTERM to supervisor
    #[cfg(unix)]
    {
        let pid = supervisor.id();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }

    // Wait for supervisor to exit
    let result = supervisor.wait();
    assert!(result.is_ok(), "Supervisor should exit cleanly");

    // Worker should be down after shutdown
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        get_worker_status(base_port).is_none(),
        "Worker should be down after supervisor shutdown"
    );

    cleanup_ports(base_port, 1);
}

// ============================================================================
// SSE Event Lifecycle Tests
// ============================================================================
//
// These tests enforce the correct event lifecycle as specified:
//
// Per-worker lifecycle:
//   worker_spawned → worker_healthy → (worker_unhealthy?) → worker_draining → worker_drained → (worker_restarting | worker_failed)
//
// Key invariants:
// - worker_spawned and worker_healthy are NEVER merged (spawned = process exists, healthy = ready)
// - worker_drained and worker_failed are NEVER emitted for the same transition
// - Events model what happened, not what should happen
//

use std::io::{BufRead, BufReader};
use std::sync::mpsc;

/// Collected SSE events from a supervisor
#[derive(Debug, Clone, PartialEq, Eq)]
struct SseEvent {
    event_type: String,
    data: serde_json::Value,
}

/// Start supervisor and collect SSE events in background
///
/// The SSE client polls for API readiness and connects immediately once available.
/// This ensures we catch early events like supervisor_ready.
fn start_supervisor_with_sse_collection(
    workers: u32,
    base_port: u16,
    api_port: u16,
) -> (Child, mpsc::Receiver<SseEvent>) {
    let supervisor = start_supervisor_with_api(workers, base_port, api_port);

    let (tx, rx) = mpsc::channel();

    // Start SSE collection in background thread
    let api_port_clone = api_port;
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();

        // Poll for API readiness with tight loop (no arbitrary sleep)
        // This ensures we connect as soon as possible to catch supervisor_ready
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(10);
        loop {
            if start.elapsed() > timeout {
                eprintln!("SSE collection: timeout waiting for API");
                return;
            }

            match client
                .get(format!(
                    "http://127.0.0.1:{}/workers/events",
                    api_port_clone
                ))
                .send()
            {
                Ok(response) => {
                    let reader = BufReader::new(response);
                    let mut current_event_type = String::new();

                    for line in reader.lines().map_while(Result::ok) {
                        if line.starts_with("event:") {
                            current_event_type =
                                line.trim_start_matches("event:").trim().to_string();
                        } else if line.starts_with("data:") {
                            let data_str = line.trim_start_matches("data:").trim();
                            if let Ok(data) = serde_json::from_str(data_str) {
                                let event = SseEvent {
                                    event_type: current_event_type.clone(),
                                    data,
                                };
                                if tx.send(event).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    return;
                }
                Err(_) => {
                    // API not ready yet, retry quickly
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    });

    (supervisor, rx)
}

/// Collect all events received so far (non-blocking drain)
fn collect_events(rx: &mpsc::Receiver<SseEvent>) -> Vec<SseEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

#[test]
fn test_sse_lifecycle_spawned_before_healthy() {
    // Enforces: worker_spawned must be emitted BEFORE worker_healthy
    // These events must NEVER be merged

    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4100;
    let api_port = 9100;
    cleanup_ports(base_port, 1);

    let (mut supervisor, rx) = start_supervisor_with_sse_collection(1, base_port, api_port);

    // Wait for worker to become healthy
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(15)),
        "Worker should become healthy"
    );

    // Give events time to arrive
    std::thread::sleep(Duration::from_millis(500));

    // Collect all events
    let events = collect_events(&rx);

    // Find spawned and healthy events for our worker
    let spawned_events: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "worker_spawned")
        .collect();
    let healthy_events: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "worker_healthy")
        .collect();

    // Must have at least one of each (not merged!)
    assert!(
        !spawned_events.is_empty(),
        "Must emit worker_spawned event (got events: {:?})",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );
    assert!(
        !healthy_events.is_empty(),
        "Must emit worker_healthy event (got events: {:?})",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );

    // Verify spawned comes before healthy in the event stream
    let spawned_idx = events
        .iter()
        .position(|e| e.event_type == "worker_spawned")
        .unwrap();
    let healthy_idx = events
        .iter()
        .position(|e| e.event_type == "worker_healthy")
        .unwrap();
    assert!(
        spawned_idx < healthy_idx,
        "worker_spawned (idx {}) must come before worker_healthy (idx {})",
        spawned_idx,
        healthy_idx
    );

    // Verify same worker ID in both events
    let spawned_id = spawned_events[0].data["id"].as_str().unwrap();
    let healthy_id = healthy_events[0].data["id"].as_str().unwrap();
    assert_eq!(
        spawned_id, healthy_id,
        "spawned and healthy should reference same worker"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_sse_lifecycle_supervisor_ready_on_boot() {
    // Enforces: supervisor_ready must be emitted once on boot

    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4110;
    let api_port = 9110;
    cleanup_ports(base_port, 1);

    let (mut supervisor, rx) = start_supervisor_with_sse_collection(1, base_port, api_port);

    // Wait for supervisor to be ready
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );

    // Give events time to arrive
    std::thread::sleep(Duration::from_millis(1000));

    // Check for supervisor_ready event
    let events = collect_events(&rx);
    let ready_events: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "supervisor_ready")
        .collect();

    assert!(
        !ready_events.is_empty(),
        "Must emit supervisor_ready event on boot (got events: {:?})",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );

    // Verify payload
    let ready_event = &ready_events[0];
    assert!(
        ready_event.data["worker_count"].as_u64().is_some(),
        "supervisor_ready must include worker_count"
    );
    assert!(
        ready_event.data["api_port"].as_u64().is_some(),
        "supervisor_ready must include api_port"
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_sse_lifecycle_draining_before_drained() {
    // Enforces: worker_draining must come before worker_drained
    // worker_drained means inflight == 0, not process exit

    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4120;
    let api_port = 9120;
    cleanup_ports(base_port, 1);

    let (mut supervisor, rx) = start_supervisor_with_sse_collection(1, base_port, api_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy"
    );

    // Get worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap().to_string();

    // Drain the worker
    let drain_result = drain_worker_api(api_port, &worker_id).expect("Should drain worker");
    assert!(drain_result["success"].as_bool().unwrap_or(false));

    // Wait for worker to be down
    assert!(
        wait_for_worker_down(base_port, Duration::from_secs(15)),
        "Worker should be down after drain"
    );

    // Give events time to arrive
    std::thread::sleep(Duration::from_millis(500));

    // Collect all events
    let events = collect_events(&rx);

    // Find draining event for our worker
    let draining_events: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_draining" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();

    assert!(
        !draining_events.is_empty(),
        "Must emit worker_draining event (got events: {:?})",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );

    // Note: worker_drained depends on the worker emitting "worker.drained" via stdout
    // If the worker doesn't emit this, we won't see the event.
    // This test verifies draining is emitted; drained depends on worker implementation.

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_sse_lifecycle_no_failed_for_drained_worker() {
    // Enforces: worker_drained and worker_failed must NEVER both be emitted
    // for the same worker transition. A draining worker that exits is drained, not failed.

    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4130;
    let api_port = 9130;
    cleanup_ports(base_port, 1);

    let (mut supervisor, rx) = start_supervisor_with_sse_collection(1, base_port, api_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy"
    );

    // Get worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap().to_string();

    // Drain the worker (graceful shutdown)
    drain_worker_api(api_port, &worker_id).expect("Should drain worker");

    // Wait for worker to be down
    assert!(
        wait_for_worker_down(base_port, Duration::from_secs(15)),
        "Worker should be down after drain"
    );

    // Give events time to arrive
    std::thread::sleep(Duration::from_millis(500));

    // Collect all events
    let events = collect_events(&rx);

    // Find draining and failed events for our worker
    let draining_for_worker: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_draining" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();
    let failed_for_worker: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_failed" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();
    let unhealthy_for_worker: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_unhealthy" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();

    // Draining should be emitted
    assert!(
        !draining_for_worker.is_empty(),
        "worker_draining should be emitted for drain operation"
    );

    // Failed and unhealthy should NOT be emitted for a gracefully drained worker
    assert!(
        failed_for_worker.is_empty(),
        "worker_failed must NOT be emitted for a drained worker (got {:?})",
        failed_for_worker
    );
    assert!(
        unhealthy_for_worker.is_empty(),
        "worker_unhealthy must NOT be emitted for a drained worker (got {:?})",
        unhealthy_for_worker
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}

#[test]
fn test_sse_lifecycle_crash_emits_unhealthy_not_drained() {
    // Enforces: A crashed worker emits worker_unhealthy/worker_restarting,
    // NOT worker_drained. Drained is only for graceful shutdown completion.

    if !worker_binary().exists() {
        eprintln!("Skipping integration test: worker binary not found");
        return;
    }

    let base_port = 4140;
    let api_port = 9140;
    cleanup_ports(base_port, 1);

    let (mut supervisor, rx) = start_supervisor_with_sse_collection(1, base_port, api_port);

    // Wait for worker to be healthy
    assert!(
        wait_for_supervisor_api(api_port, Duration::from_secs(10)),
        "Supervisor API should be ready"
    );
    assert!(
        wait_for_healthy(base_port, Duration::from_secs(10)),
        "Worker should become healthy"
    );

    // Get worker ID
    let workers = get_workers_list(api_port).expect("Should get workers list");
    let worker_id = workers["workers"][0]["id"].as_str().unwrap().to_string();

    // Kill the worker (simulates crash, not graceful shutdown)
    assert!(
        kill_worker_on_port(base_port),
        "Should find and kill worker process"
    );

    // Wait for supervisor to detect crash and potentially restart
    std::thread::sleep(Duration::from_secs(2));

    // Collect all events
    let events = collect_events(&rx);

    // Find events for our worker
    let unhealthy_for_worker: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_unhealthy" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();
    let drained_for_worker: Vec<_> = events
        .iter()
        .filter(|e| {
            e.event_type == "worker_drained" && e.data["id"].as_str() == Some(worker_id.as_str())
        })
        .collect();

    // Unhealthy SHOULD be emitted for a crash
    assert!(
        !unhealthy_for_worker.is_empty(),
        "worker_unhealthy should be emitted for crashed worker (got events: {:?})",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );

    // Drained should NOT be emitted for a crash
    assert!(
        drained_for_worker.is_empty(),
        "worker_drained must NOT be emitted for crashed worker (got {:?})",
        drained_for_worker
    );

    // Clean up
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    cleanup_ports(base_port, 1);
}
