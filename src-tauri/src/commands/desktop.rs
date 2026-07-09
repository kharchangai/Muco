use screenshots::Screen;
// Use the internal ImageFormat from screenshots crate to avoid version conflicts
use base64::{prelude::BASE64_STANDARD, Engine};
use screenshots::image::ImageFormat;
use std::io::Cursor;

#[tauri::command]
pub async fn capture_desktop() -> Result<String, String> {
    // Get all available screens
    let screens = Screen::all().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screens detected on this system.".to_string());
    }

    // Capture the primary screen
    let primary_screen = screens[0];
    let image = primary_screen.capture().map_err(|e| e.to_string())?;

    // Convert buffer to JPEG format using screenshots' own ImageFormat
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    image
        .write_to(&mut cursor, ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;

    // Encode to Base64
    let base64_image = BASE64_STANDARD.encode(&buffer);

    Ok(format!("data:image/jpeg;base64,{}", base64_image))
}
