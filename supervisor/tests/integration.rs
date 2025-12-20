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
