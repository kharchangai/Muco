use rdev::{listen, EventType};
use std::thread;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

// Correctly declare the commands module with a semicolon
mod commands;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Keeping the standard mobile entry point attribute (or use your custom macro if required)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // Register all necessary plugins
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // Register both commands (greet and capture_desktop)
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::desktop::capture_desktop
        ])
        .setup(|app| {
            // Setup Window Menu Items
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            // Get default window icon
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("Default window icon is not configured");

            // Setup System Tray Icon
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(settings_win) = app.get_webview_window("settings") {
                            let _ = settings_win.show();
                            let _ = settings_win.set_focus();
                        } else {
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "settings",
                                WebviewUrl::App("/#settings".into()),
                            )
                            .title("Mocu Settings")
                            .inner_size(420.0, 520.0)
                            .resizable(false)
                            .decorations(true)
                            .always_on_top(true)
                            .build();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Setup Keyboard Listener in a background thread
            let app_handle = app.handle().clone();

            thread::spawn(move || {
                if let Err(error) = listen(move |event| {
                    if let EventType::KeyPress(_) = event.event_type {
                        let _ = app_handle.emit("user_typing", ());
                    }
                }) {
                    println!("Error listening to keyboard: {:?}", error);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
