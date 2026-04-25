// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// Holds the sidecar server process so we can kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

/// Wait for the Hono server to become ready on localhost:3456.
/// Polls every 200ms up to ~15 seconds.
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
            // Kill the sidecar when the main window is destroyed.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window
                    .app_handle()
                    .state::<ServerProcess>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running takode");
}
