#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{error, info};

/// Events emitted by a worker process
#[derive(Debug, Clone)]
pub enum WorkerEvent {
    /// Worker is ready and accepting connections
    Ready { port: u16, worker_id: String },
    /// Worker is draining (graceful shutdown)
    Draining { worker_id: String },
    /// Worker process exited
    Exited { exit_code: Option<i32> },
    /// Stdout line (for debugging)
    Stdout(String),
    /// Stderr line (for debugging)
    Stderr(String),
}

/// Configuration for spawning a worker
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub binary_path: PathBuf,
    pub port: u16,
    pub worker_id: String,
    pub auth_secret: Option<String>,
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub env_vars: Vec<(String, String)>,
}

/// A managed worker process
pub struct Worker {
    config: WorkerConfig,
    child: Option<Child>,
    event_tx: mpsc::Sender<WorkerEvent>,
}

impl Worker {
    /// Create a new worker (not yet started)
    pub fn new(config: WorkerConfig, event_tx: mpsc::Sender<WorkerEvent>) -> Self {
        Self {
            config,
            child: None,
            event_tx,
        }
    }

    /// Spawn the worker process
    pub async fn spawn(&mut self) -> Result<(), std::io::Error> {
        info!(
            worker_id = %self.config.worker_id,
            port = %self.config.port,
            binary = %self.config.binary_path.display(),
            "Spawning worker"
        );

        let mut cmd = Command::new(&self.config.binary_path);

        // Set environment variables
        cmd.env("PORT", self.config.port.to_string());
        cmd.env("WORKER_ID", &self.config.worker_id);

        if let Some(ref secret) = self.config.auth_secret {
            cmd.env("L0_AUTH_SECRET", secret);
        }

        if let Some(ref key) = self.config.openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }

        if let Some(ref key) = self.config.anthropic_api_key {
            cmd.env("ANTHROPIC_API_KEY", key);
        }

        for (key, value) in &self.config.env_vars {
            cmd.env(key, value);
        }

        // Capture stdout/stderr
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn()?;

        // Spawn stdout reader task
        if let Some(stdout) = child.stdout.take() {
            let tx = self.event_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();

                while let Ok(Some(line)) = lines.next_line().await {
                    // Try to parse structured events
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(event_type) = event.get("event").and_then(|v| v.as_str()) {
                            match event_type {
                                "worker.ready" => {
                                    let port = event
                                        .get("port")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0) as u16;
                                    let worker_id = event
                                        .get("workerId")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let _ = tx.send(WorkerEvent::Ready { port, worker_id }).await;
                                    continue;
                                }
                                "worker.draining" => {
                                    let worker_id = event
                                        .get("workerId")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let _ = tx.send(WorkerEvent::Draining { worker_id }).await;
                                    continue;
                                }
                                _ => {}
                            }
                        }
                    }

                    // Forward as stdout event
                    let _ = tx.send(WorkerEvent::Stdout(line)).await;
                }
            });
        }

        // Spawn stderr reader task
        if let Some(stderr) = child.stderr.take() {
            let tx = self.event_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();

                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(WorkerEvent::Stderr(line)).await;
                }
            });
        }

        self.child = Some(child);
        Ok(())
    }

    /// Wait for the worker process to exit
    pub async fn wait(&mut self) -> Option<i32> {
        if let Some(ref mut child) = self.child {
            match child.wait().await {
                Ok(status) => {
                    let code = status.code();
                    let _ = self.event_tx.send(WorkerEvent::Exited { exit_code: code }).await;
                    code
                }
                Err(e) => {
                    error!(error = %e, "Failed to wait for worker");
                    let _ = self
                        .event_tx
                        .send(WorkerEvent::Exited { exit_code: None })
                        .await;
                    None
                }
            }
        } else {
            None
        }
    }

    /// Send SIGTERM to the worker for graceful shutdown
    #[cfg(unix)]
    pub async fn terminate(&mut self) -> Result<(), std::io::Error> {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        if let Some(ref child) = self.child {
            if let Some(pid) = child.id() {
                info!(worker_id = %self.config.worker_id, pid = pid, "Sending SIGTERM to worker");
                kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            }
        }
        Ok(())
    }

    /// Send SIGTERM to the worker for graceful shutdown (Windows fallback)
    #[cfg(not(unix))]
    pub async fn terminate(&mut self) -> Result<(), std::io::Error> {
        if let Some(ref mut child) = self.child {
            child.kill().await?;
        }
        Ok(())
    }

    /// Force kill the worker
    pub async fn kill(&mut self) -> Result<(), std::io::Error> {
        if let Some(ref mut child) = self.child {
            info!(worker_id = %self.config.worker_id, "Force killing worker");
            child.kill().await?;
        }
        Ok(())
    }

    /// Check if the worker process is still running
    pub fn is_running(&mut self) -> bool {
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(None) => true, // Still running
                Ok(Some(_)) => false, // Exited
                Err(_) => false, // Error checking
            }
        } else {
            false
        }
    }

    /// Get the worker ID
    pub fn worker_id(&self) -> &str {
        &self.config.worker_id
    }

    /// Get the configured port
    pub fn port(&self) -> u16 {
        self.config.port
    }
}
