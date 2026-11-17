//! Local mods: files the user drops into DriftKord's mods folder (or imports from the app).
//!  * `.css`  — style mods, applied live
//!  * `.js`   — script mods, run inside DriftKord's window with the `DriftKord` mod API (opt-in, trusted)
//!  * `.json` / `.dktheme` — Custom-theme presets
//! Which mods are switched on is stored by the frontend; this module only manages the files.

use serde::Serialize;
use std::path::{Path, PathBuf};

const EXTS: &[&str] = &["css", "js", "json", "dktheme"];
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInfo {
    pub file: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub size: u64,
}

pub fn dir(data_dir: &Path) -> Result<PathBuf, String> {
    let d = data_dir.join("mods");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn kind_of(p: &Path) -> Option<&'static str> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "css" => Some("css"),
        "js" => Some("js"),
        "json" | "dktheme" => Some("theme"),
        _ => None,
    }
}

/// Read `@name`, `@description`, `@author`, `@version` from the first comment block (or JSON fields).
fn header(text: &str, kind: &str) -> (String, String, String, String) {
    if kind == "theme" {
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::Value::Null);
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        return (s("name"), s("description"), s("author"), s("version"));
    }
    let head: String = text.chars().take(2000).collect();
    let tag = |t: &str| -> String {
        head.lines()
            .find_map(|l| l.split_once(&format!("@{t}")).map(|(_, r)| r.trim().trim_end_matches("*/").trim().to_string()))
            .unwrap_or_default()
    };
    (tag("name"), tag("description"), tag("author"), tag("version"))
}

/// A safe file name inside the mods folder (no paths, no traversal).
fn safe_name(file: &str) -> Result<String, String> {
    let name = Path::new(file).file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    if name.starts_with('.') || name.contains("..") {
        return Err("bad file name".into());
    }
    Ok(name.to_string())
}

pub fn list(data_dir: &Path) -> Result<Vec<ModInfo>, String> {
    let d = dir(data_dir)?;
    let mut out = vec![];
    for e in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let Some(kind) = kind_of(&p) else { continue };
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() || meta.len() > MAX_BYTES {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let (name, description, author, version) = header(&text, kind);
        let file = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        out.push(ModInfo { name: if name.is_empty() { file.clone() } else { name }, file, kind: kind.into(), description, author, version, size: meta.len() });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn import(data_dir: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let d = dir(data_dir)?;
    let mut added = vec![];
    for src in paths {
        let p = Path::new(src);
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !EXTS.contains(&ext.as_str()) {
            return Err(format!("{} isn't a mod (use .css, .js, .json or .dktheme)", p.display()));
        }
        let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
        if len > MAX_BYTES {
            return Err(format!("{} is larger than 2 MB", p.display()));
        }
        let name = safe_name(src)?;
        std::fs::copy(p, d.join(&name)).map_err(|e| e.to_string())?;
        added.push(name);
    }
    Ok(added)
}

pub fn read(data_dir: &Path, file: &str) -> Result<String, String> {
    let p = dir(data_dir)?.join(safe_name(file)?);
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

pub fn write(data_dir: &Path, file: &str, text: &str) -> Result<(), String> {
    let name = safe_name(file)?;
    if kind_of(Path::new(&name)).is_none() {
        return Err("unsupported mod type".into());
    }
    std::fs::write(dir(data_dir)?.join(name), text).map_err(|e| e.to_string())
}

pub fn remove(data_dir: &Path, file: &str) -> Result<(), String> {
    let p = dir(data_dir)?.join(safe_name(file)?);
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

pub fn open_folder(data_dir: &Path) -> Result<(), String> {
    let d = dir(data_dir)?;
    std::process::Command::new("explorer").arg(d).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
