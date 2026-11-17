//! Windows shell integration (per-user, no admin rights needed):
//!  * ProgID + "Open with" entries for every supported extension
//!  * Explorer context menu: "Play with DriftKord", "Add to DriftKord queue"
//!  * Folder context menu: "Add folder to DriftKord library"
//!  * Registered Application capabilities so it shows up in Settings ▸ Default apps
//! Windows 11 does not let apps silently take over defaults; `open_default_apps` opens the
//! Settings page pre-filtered to this app.

use serde::Serialize;
use winreg::enums::*;
use winreg::RegKey;

const PROGID: &str = "DriftKord.Audio";
const APP_NAME: &str = "DriftKord";
const EXTS: &[&str] = &[
    ".flac", ".wav", ".mp3", ".ogg", ".oga", ".m4a", ".aac", ".aif", ".aiff", ".dsf", ".mka", ".caf",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub registered: bool,
    pub exe_path: String,
    pub registered_exe: Option<String>,
}

fn exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())
}

fn notify_shell() {
    unsafe {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

pub fn register() -> Result<(), String> {
    let exe = exe()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS).map_err(|e| e.to_string())?;
    let err = |e: std::io::Error| e.to_string();

    // ProgID
    let (prog, _) = classes.create_subkey(PROGID).map_err(err)?;
    prog.set_value("", &format!("{APP_NAME} audio file")).map_err(err)?;
    prog.set_value("FriendlyTypeName", &format!("{APP_NAME} audio file")).map_err(err)?;
    let (icon, _) = prog.create_subkey("DefaultIcon").map_err(err)?;
    icon.set_value("", &format!("\"{exe}\",0")).map_err(err)?;
    let (open, _) = prog.create_subkey("shell\\open\\command").map_err(err)?;
    open.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(err)?;
    let (enq, _) = prog.create_subkey("shell\\enqueue").map_err(err)?;
    enq.set_value("", &"Add to DriftKord queue").map_err(err)?;
    let (enqc, _) = prog.create_subkey("shell\\enqueue\\command").map_err(err)?;
    enqc.set_value("", &format!("\"{exe}\" --enqueue \"%1\"")).map_err(err)?;

    // Open-with list for each extension (does not hijack the current default)
    for ext in EXTS {
        let (k, _) = classes.create_subkey(format!("{ext}\\OpenWithProgids")).map_err(err)?;
        k.set_value(PROGID, &"").map_err(err)?;
    }

    // Context menus on every audio file type
    let (play, _) = classes
        .create_subkey("SystemFileAssociations\\audio\\shell\\DriftKord.Play")
        .map_err(err)?;
    play.set_value("", &"Play with DriftKord").map_err(err)?;
    play.set_value("Icon", &format!("\"{exe}\",0")).map_err(err)?;
    play.set_value("MultiSelectModel", &"Player").map_err(err)?;
    let (pc, _) = play.create_subkey("command").map_err(err)?;
    pc.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(err)?;

    let (q, _) = classes
        .create_subkey("SystemFileAssociations\\audio\\shell\\DriftKord.Enqueue")
        .map_err(err)?;
    q.set_value("", &"Add to DriftKord queue").map_err(err)?;
    q.set_value("Icon", &format!("\"{exe}\",0")).map_err(err)?;
    q.set_value("MultiSelectModel", &"Player").map_err(err)?;
    let (qc, _) = q.create_subkey("command").map_err(err)?;
    qc.set_value("", &format!("\"{exe}\" --enqueue \"%1\"")).map_err(err)?;

    let (d, _) = classes.create_subkey("Directory\\shell\\DriftKord.AddFolder").map_err(err)?;
    d.set_value("", &"Add folder to DriftKord library").map_err(err)?;
    d.set_value("Icon", &format!("\"{exe}\",0")).map_err(err)?;
    let (dc, _) = d.create_subkey("command").map_err(err)?;
    dc.set_value("", &format!("\"{exe}\" --add-folder \"%1\"")).map_err(err)?;

    // Applications entry
    let (app, _) = classes.create_subkey("Applications\\DriftKord.exe").map_err(err)?;
    app.set_value("FriendlyAppName", &APP_NAME).map_err(err)?;
    let (st, _) = app.create_subkey("SupportedTypes").map_err(err)?;
    for ext in EXTS {
        st.set_value(*ext, &"").map_err(err)?;
    }
    let (ac, _) = app.create_subkey("shell\\open\\command").map_err(err)?;
    ac.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(err)?;

    // Default-apps capabilities
    let (cap, _) = hkcu.create_subkey("Software\\DriftKord\\Capabilities").map_err(err)?;
    cap.set_value("ApplicationName", &APP_NAME).map_err(err)?;
    cap.set_value("ApplicationDescription", &"Bit-perfect audiophile music player").map_err(err)?;
    cap.set_value("ApplicationIcon", &format!("\"{exe}\",0")).map_err(err)?;
    let (fa, _) = cap.create_subkey("FileAssociations").map_err(err)?;
    for ext in EXTS {
        fa.set_value(*ext, &PROGID).map_err(err)?;
    }
    let (ra, _) = hkcu.create_subkey("Software\\RegisteredApplications").map_err(err)?;
    ra.set_value(APP_NAME, &"Software\\DriftKord\\Capabilities").map_err(err)?;
    let (me, _) = hkcu.create_subkey("Software\\DriftKord").map_err(err)?;
    me.set_value("InstallPath", &exe).map_err(err)?;

    notify_shell();
    Ok(())
}

pub fn unregister() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(classes) = hkcu.open_subkey_with_flags("Software\\Classes", KEY_ALL_ACCESS) {
        let _ = classes.delete_subkey_all(PROGID);
        let _ = classes.delete_subkey_all("SystemFileAssociations\\audio\\shell\\DriftKord.Play");
        let _ = classes.delete_subkey_all("SystemFileAssociations\\audio\\shell\\DriftKord.Enqueue");
        let _ = classes.delete_subkey_all("Directory\\shell\\DriftKord.AddFolder");
        let _ = classes.delete_subkey_all("Applications\\DriftKord.exe");
        for ext in EXTS {
            if let Ok(k) = classes.open_subkey_with_flags(format!("{ext}\\OpenWithProgids"), KEY_ALL_ACCESS) {
                let _ = k.delete_value(PROGID);
            }
        }
    }
    if let Ok(ra) = hkcu.open_subkey_with_flags("Software\\RegisteredApplications", KEY_ALL_ACCESS) {
        let _ = ra.delete_value(APP_NAME);
    }
    let _ = hkcu.delete_subkey_all("Software\\DriftKord\\Capabilities");
    notify_shell();
    Ok(())
}

pub fn status() -> ShellStatus {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let registered_exe: Option<String> = hkcu
        .open_subkey(format!("Software\\Classes\\{PROGID}\\shell\\open\\command"))
        .and_then(|k| k.get_value::<String, _>(""))
        .ok();
    ShellStatus {
        registered: registered_exe.is_some(),
        exe_path: exe().unwrap_or_default(),
        registered_exe,
    }
}

pub fn open_default_apps() -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // Windows only lists DriftKord on its Default-apps page once it's registered as a music player
    if !status().registered {
        register()?;
    }
    let open = |uri: &str| -> bool {
        let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(uri), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        r.0 as isize > 32
    };
    // straight to DriftKord's own page in Settings → Apps → Default apps; fall back to the list
    if open(&format!("ms-settings:defaultapps?registeredAppUser={}", APP_NAME.replace(' ', "%20"))) || open("ms-settings:defaultapps") {
        Ok(())
    } else {
        Err("Couldn't open Windows Settings → Default apps".into())
    }
}
