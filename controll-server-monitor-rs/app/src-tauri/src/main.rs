#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use windows_service::service::{ServiceAccess, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

const SERVICE_NAME: &str = "ControllServerMonitor";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STATUS_POLL_SECONDS: u64 = 3;

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Reading service status needs only CONNECT + QUERY_STATUS, which ordinary
/// users already have — so the menu can show live state without prompting.
/// `None` means the service isn't installed (or can't be opened at all).
fn service_state() -> Option<ServiceState> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .ok()?;
    service.query_status().ok().map(|status| status.current_state)
}

/// Starting and stopping a service *does* require elevation, which this app
/// does not have, so hand the request to an elevated `sc.exe` via the runas
/// verb. Windows shows its own UAC prompt; there is no way to avoid that
/// without weakening the service's security descriptor at install time.
fn request_service_control(action: &str) {
    let script = format!(
        "Start-Process sc.exe -ArgumentList '{action}','{SERVICE_NAME}' -Verb RunAs -WindowStyle Hidden"
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Backs the Setup screen's Export Sites button when running inside this app
/// (as opposed to a plain browser tab, where the existing `<a download>`
/// blob trick already works fine). The webview only picks the destination
/// path via the native dialog plugin; writing the bytes is a plain app
/// command rather than pulling in tauri-plugin-fs's broader filesystem
/// surface for a single, narrow write.
#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|err| err.to_string())
}

fn refresh_menu_state(
    status_item: &MenuItem<tauri::Wry>,
    start_item: &MenuItem<tauri::Wry>,
    stop_item: &MenuItem<tauri::Wry>,
) {
    let (label, can_start, can_stop) = match service_state() {
        Some(ServiceState::Running) => ("Service: running", false, true),
        Some(ServiceState::Stopped) => ("Service: stopped", true, false),
        // Start/stop pending — leave both disabled so the next poll settles it.
        Some(_) => ("Service: changing state...", false, false),
        None => ("Service: not installed", false, false),
    };

    let _ = status_item.set_text(label);
    let _ = start_item.set_enabled(can_start);
    let _ = stop_item.set_enabled(can_stop);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_export_file])
        .setup(|app| {
            let status = MenuItem::with_id(app, "status", "Service: checking...", false, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start Service", false, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Service", false, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let show = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&status, &start, &stop, &separator, &show, &quit],
            )?;

            refresh_menu_state(&status, &start, &stop);

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Controll Server Monitor")
                .menu(&menu)
                // The menu must not open on left click, otherwise the
                // click-to-show handler below never sees the event.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "start" => request_service_control("start"),
                    "stop" => request_service_control("stop"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // The service can also be started or stopped from outside this app
            // (services.msc, sc.exe, a crash), so poll rather than only updating
            // after our own menu actions. This also covers the delay between
            // requesting a change and Windows actually completing it.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(STATUS_POLL_SECONDS));

                let (status, start, stop) = (status.clone(), start.clone(), stop.clone());
                let _ = handle.run_on_main_thread(move || {
                    refresh_menu_state(&status, &start, &stop);
                });
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray instead of exiting. The
            // Windows Service keeps monitoring either way; this just keeps the
            // GUI one click away rather than requiring a relaunch.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
