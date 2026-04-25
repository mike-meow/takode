// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// Holds the sidecar server process so we can kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

/// Wait for a TCP server to become ready on localhost.
/// Polls every 200ms up to the given timeout.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    let addr = format!("127.0.0.1:{}", port);
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect(&addr).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Gracefully shut down a child process: SIGTERM first, wait up to 2s,
/// then SIGKILL if still alive.
fn graceful_shutdown(child: &mut Child) {
    // Send SIGTERM via libc (Child::kill sends SIGKILL).
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        // Wait up to 2 seconds for the process to exit.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => break, // timed out or error — fall through to SIGKILL
            }
        }
    }
    // Fallback: force kill.
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    let port: u16 = 3456;

    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(move |app| {
            // Resolve paths relative to the app bundle's Resources directory.
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");

            let bun_bin = resource_dir.join("binaries").join("bun");
            let web_dir = resource_dir.join("web");

            // Spawn bun to start the Hono server.
            let child = Command::new(&bun_bin)
                .arg("run")
                .arg("start")
                .current_dir(&web_dir)
                .env("PORT", port.to_string())
                .spawn()
                .expect("failed to start bun server sidecar");

            // Store the child process handle for cleanup.
            let state = app.state::<ServerProcess>();
            *state.0.lock().unwrap() = Some(child);

            // Wait for the server to accept connections before the webview loads.
            if !wait_for_server(port, Duration::from_secs(15)) {
                eprintln!("WARNING: server did not become ready within 15 seconds");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Gracefully stop the sidecar when the main window is destroyed.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window
                    .app_handle()
                    .state::<ServerProcess>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    graceful_shutdown(&mut child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running takode");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Binding a listener on a port should make wait_for_server return true.
    #[test]
    fn wait_for_server_returns_true_when_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(wait_for_server(port, Duration::from_secs(2)));
        drop(listener);
    }

    /// When nothing is listening, wait_for_server should return false after timeout.
    #[test]
    fn wait_for_server_returns_false_on_timeout() {
        // Bind and immediately drop to get a port that's definitely free.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // Use a short timeout so the test doesn't take long.
        assert!(!wait_for_server(port, Duration::from_millis(400)));
    }
}
