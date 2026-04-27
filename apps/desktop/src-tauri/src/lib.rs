use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![set_menu_strings])
        .setup(|app| {
            // Build the application menu and attach it. Each custom item
            // emits a `menu` event with the item id so the JS side can
            // dispatch into the right Pinia action.
            //
            // Strings here are English fallbacks. Once the webview comes
            // up and i18n is initialized, the JS side calls the
            // `set_menu_strings` command to rebuild the menu in the
            // user's selected locale. The English flash before that is
            // unavoidable but lasts only the boot-to-first-render window.
            let menu = build_menu(app.handle(), &MenuStrings::default())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Forward the click to the webview. The id is whatever we
            // assigned to the MenuItem; predefined items are handled by
            // Tauri natively (Quit, Copy/Cut/Paste, etc.) and never
            // reach this handler.
            let id = event.id().0.clone();
            let _ = app.emit("menu", id);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Localized titles for every custom menu item. Predefined items
/// (Cut/Copy/Paste/Quit/etc.) are localized by the OS itself, so they
/// don't appear here.
///
/// `serde(rename_all = "camelCase")` keeps the JS object keys natural
/// (`newCurlTab`) without forcing snake_case on the JS side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuStrings {
    file: String,
    edit: String,
    view: String,
    workspace: String,
    help: String,
    new_curl_tab: String,
    new_collection: String,
    import: String,
    export: String,
    settings: String,
    toggle_sidebar: String,
    zoom_in: String,
    zoom_out: String,
    zoom_reset: String,
    sync_now: String,
    new_environment: String,
    documentation: String,
    about: String,
}

impl Default for MenuStrings {
    fn default() -> Self {
        Self {
            file: "File".into(),
            edit: "Edit".into(),
            view: "View".into(),
            workspace: "Workspace".into(),
            help: "Help".into(),
            new_curl_tab: "New curl tab".into(),
            new_collection: "New collection…".into(),
            import: "Import collection…".into(),
            export: "Export backup…".into(),
            settings: "Settings…".into(),
            toggle_sidebar: "Toggle sidebar".into(),
            zoom_in: "Zoom in".into(),
            zoom_out: "Zoom out".into(),
            zoom_reset: "Reset zoom".into(),
            sync_now: "Sync now".into(),
            new_environment: "New environment…".into(),
            documentation: "Documentation".into(),
            about: "About Aelvory".into(),
        }
    }
}

/// Rebuild the menu with locale-specific titles and atomically swap it.
/// Called by the JS side via `invoke('set_menu_strings', ...)` after
/// i18n is ready, and again whenever the user changes the language.
#[tauri::command]
fn set_menu_strings(app: tauri::AppHandle, strings: MenuStrings) -> Result<(), String> {
    let menu = build_menu(&app, &strings).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    s: &MenuStrings,
) -> Result<tauri::menu::Menu<R>, tauri::Error> {
    // ---------- File ----------
    let new_curl = MenuItemBuilder::with_id("file.new_curl", &s.new_curl_tab)
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_collection = MenuItemBuilder::with_id("file.new_collection", &s.new_collection)
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let import_collection = MenuItemBuilder::with_id("file.import", &s.import)
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let export_backup = MenuItemBuilder::with_id("file.export", &s.export)
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("file.settings", &s.settings)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;

    let file = SubmenuBuilder::new(app, &s.file)
        .item(&new_curl)
        .item(&new_collection)
        .separator()
        .item(&import_collection)
        .item(&export_backup)
        .separator()
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;

    // ---------- Edit ----------
    // Predefined items wire up the OS-correct shortcuts and behavior
    // (e.g. macOS Cmd+Z, redo on the right modifier, etc.) without us
    // hand-rolling them. They're also OS-localized natively.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;

    let edit = SubmenuBuilder::new(app, &s.edit)
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .separator()
        .item(&select_all)
        .build()?;

    // ---------- View ----------
    let toggle_sidebar = MenuItemBuilder::with_id("view.toggle_sidebar", &s.toggle_sidebar)
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("view.zoom_in", &s.zoom_in)
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view.zoom_out", &s.zoom_out)
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view.zoom_reset", &s.zoom_reset)
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view = SubmenuBuilder::new(app, &s.view)
        .item(&toggle_sidebar)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    // ---------- Workspace ----------
    let sync_now = MenuItemBuilder::with_id("workspace.sync", &s.sync_now)
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let new_environment = MenuItemBuilder::with_id("workspace.new_environment", &s.new_environment)
        .build(app)?;

    let workspace = SubmenuBuilder::new(app, &s.workspace)
        .item(&sync_now)
        .separator()
        .item(&new_environment)
        .build()?;

    // ---------- Help ----------
    let docs = MenuItemBuilder::with_id("help.docs", &s.documentation).build(app)?;
    let about = MenuItemBuilder::with_id("help.about", &s.about).build(app)?;

    let help = SubmenuBuilder::new(app, &s.help)
        .item(&docs)
        .item(&about)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &workspace, &help])
        .build()?;

    Ok(menu)
}
