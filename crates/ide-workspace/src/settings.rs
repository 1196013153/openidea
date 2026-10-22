use ide_core::settings::Settings;
use ide_core::{IdeError, IdeResult, project_dir};
use parking_lot::RwLock;
use serde_json::Value as Json;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item, Table, TableLike};

/// Layered settings: defaults → `<app-config>/settings.toml` → `<project>/.openidea/settings.toml`.
/// Writes go through `toml_edit` so user comments survive.
///
/// TOML keys use the camelCase names of the serde [`Settings`] struct, e.g.
/// `[editor]` / `fontSize = 14`. A layer that fails to parse or holds values of
/// the wrong type is logged and ignored as a whole.
const PROJECT_FILE: &str = "settings.toml";

pub struct SettingsStore {
    global_file: PathBuf,
    project_file: Option<PathBuf>,
    effective: RwLock<Settings>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    Global,
    Project,
}

fn defaults_json() -> Json {
    serde_json::to_value(Settings::default()).expect("settings serialize")
}

fn deep_merge(base: &mut Json, layer: Json) {
    match (base, layer) {
        (Json::Object(base), Json::Object(layer)) => {
            for (k, v) in layer {
                match base.get_mut(&k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, layer) => *base = layer,
    }
}

fn parse_layer(text: &str) -> Result<Json, String> {
    let table: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    serde_json::to_value(table).map_err(|e| e.to_string())
}

/// Reads one layer; `None` when missing or invalid (logged).
fn read_layer(file: &Path) -> Option<Json> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!("cannot read {}: {e}", file.display());
            return None;
        }
    };
    match parse_layer(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("{} is not valid TOML, ignoring it: {e}", file.display());
            None
        }
    }
}

/// Merges `layer` onto `merged` if the result still deserializes.
fn try_merge(merged: &mut Json, layer: Json) -> Result<(), String> {
    let mut candidate = merged.clone();
    deep_merge(&mut candidate, layer);
    serde_json::from_value::<Settings>(candidate.clone()).map_err(|e| e.to_string())?;
    *merged = candidate;
    Ok(())
}

fn json_to_toml(value: &Json) -> IdeResult<toml_edit::Value> {
    Ok(match value {
        Json::Null => return Err(IdeError::invalid("null is not allowed inside a settings value")),
        Json::Bool(b) => (*b).into(),
        Json::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().ok_or_else(|| IdeError::invalid(format!("unsupported number {n}")))?.into(),
        },
        Json::String(s) => s.as_str().into(),
        Json::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for item in items {
                arr.push(json_to_toml(item)?);
            }
            arr.into()
        }
        Json::Object(map) => {
            let mut t = toml_edit::InlineTable::new();
            for (k, v) in map {
                t.insert(k, json_to_toml(v)?);
            }
            t.into()
        }
    })
}

/// Sets (or removes, for `None`) a dotted key in a TOML document.
fn set_in_document(doc: &mut DocumentMut, segments: &[&str], value: Option<toml_edit::Value>) {
    let (last, parents) = segments.split_last().expect("non-empty key");
    let mut table: &mut dyn TableLike = doc.as_table_mut();
    for seg in parents {
        if !table.get(seg).is_some_and(Item::is_table_like) {
            if value.is_none() {
                return;
            }
            table.insert(seg, Item::Table(Table::new()));
        }
        table = table.get_mut(seg).and_then(Item::as_table_like_mut).expect("table just ensured");
    }
    match value {
        Some(v) => match table.get_mut(last) {
            // Keep the key's decor (comments, spacing) when replacing a value.
            Some(Item::Value(existing)) => {
                let decor = existing.decor().clone();
                *existing = v;
                *existing.decor_mut() = decor;
            }
            _ => {
                table.insert(last, Item::Value(v));
            }
        },
        None => {
            table.remove(last);
        }
    }
}

impl SettingsStore {
    pub fn load(config_dir: &Path, project_root: Option<&Path>) -> Self {
        let store = Self {
            global_file: config_dir.join("settings.toml"),
            project_file: project_root.map(|r| project_dir::path(r, PROJECT_FILE)),
            effective: RwLock::new(Settings::default()),
        };
        store.reload();
        store
    }

    pub fn file(&self, scope: SettingsScope) -> Option<&Path> {
        match scope {
            SettingsScope::Global => Some(&self.global_file),
            SettingsScope::Project => self.project_file.as_deref(),
        }
    }

    fn layers(&self) -> Vec<(SettingsScope, PathBuf)> {
        [SettingsScope::Global, SettingsScope::Project]
            .into_iter()
            .filter_map(|scope| Some((scope, self.file(scope)?.to_path_buf())))
            .collect()
    }

    fn compute(&self) -> Settings {
        let mut merged = defaults_json();
        for (_, file) in self.layers() {
            if let Some(layer) = read_layer(&file)
                && let Err(e) = try_merge(&mut merged, layer)
            {
                tracing::warn!("{} has invalid settings, ignoring it: {e}", file.display());
            }
        }
        serde_json::from_value(merged).unwrap_or_default()
    }

    /// Effective (merged) settings.
    pub fn effective(&self) -> Settings {
        self.effective.read().clone()
    }

    /// Sets one dotted key, e.g. `editor.fontSize`, to a JSON value in `scope`.
    /// `null` removes the key from that layer. Unknown keys and values of the
    /// wrong type are rejected with `InvalidInput`; the file is left untouched.
    pub fn set(&self, scope: SettingsScope, key: &str, value: serde_json::Value) -> IdeResult<Settings> {
        let file = self.file(scope).ok_or_else(|| IdeError::invalid("no project is open"))?.to_path_buf();
        let segments: Vec<&str> = key.split('.').collect();
        if segments.iter().any(|s| s.is_empty()) {
            return Err(IdeError::invalid(format!("invalid settings key {key:?}")));
        }
        let mut cursor = &defaults_json();
        for seg in &segments {
            cursor = cursor.get(seg).ok_or_else(|| IdeError::invalid(format!("unknown setting {key:?}")))?;
        }

        let text = match std::fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let mut doc: DocumentMut = text
            .parse()
            .map_err(|e| IdeError::invalid(format!("{} is not valid TOML; fix it first: {e}", file.display())))?;
        let new_value = if value.is_null() { None } else { Some(json_to_toml(&value)?) };
        set_in_document(&mut doc, &segments, new_value);
        let new_text = doc.to_string();

        // Validate the resulting stack before touching the disk.
        let mut merged = defaults_json();
        for (layer_scope, layer_file) in self.layers() {
            let is_target = layer_scope == scope;
            let layer = if is_target { parse_layer(&new_text).ok() } else { read_layer(&layer_file) };
            let Some(layer) = layer else { continue };
            if let Err(e) = try_merge(&mut merged, layer)
                && is_target
            {
                return Err(IdeError::invalid(format!("invalid value for {key}: {e}")));
            }
        }

        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        ide_vfs::write_atomic(&file, new_text.as_bytes())?;
        Ok(self.reload())
    }

    /// Re-reads all layers from disk.
    pub fn reload(&self) -> Settings {
        let settings = self.compute();
        *self.effective.write() = settings.clone();
        settings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn layering_and_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(proj.join(".openidea")).unwrap();
        std::fs::write(cfg.join("settings.toml"), "keymap = \"vscode\"\n[editor]\nfontSize = 15\ntabSize = 2\n")
            .unwrap();
        std::fs::write(proj.join(".openidea/settings.toml"), "[editor]\ntabSize = 8\n").unwrap();

        let s = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(s.keymap, "vscode");
        assert_eq!(s.editor.font_size, 15.0);
        assert_eq!(s.editor.tab_size, 8);
        assert_eq!(s.editor.font_family, "JetBrains Mono");

        // Invalid project layer: ignored, global still applies.
        std::fs::write(proj.join(".openidea/settings.toml"), "[editor]\ntabSize = \"wide\"\n").unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        assert_eq!(store.effective().editor.tab_size, 2);
        // Broken TOML in the global layer: defaults.
        std::fs::write(cfg.join("settings.toml"), "[editor\n").unwrap();
        assert_eq!(store.reload().editor.font_size, 13.0);

        let global_only = SettingsStore::load(&cfg, None);
        assert_eq!(
            global_only.set(SettingsScope::Project, "editor.fontSize", json!(1)).unwrap_err().kind,
            ide_core::error::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn set_preserves_comments_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        let original = "# My settings\n\n[editor]\n# bigger is better\nfontSize = 14 # pt\nsoftWrap = true\n";
        std::fs::write(cfg.join("settings.toml"), original).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));

        let s = store.set(SettingsScope::Global, "editor.fontSize", json!(16)).unwrap();
        assert_eq!(s.editor.font_size, 16.0);
        assert!(s.editor.soft_wrap);
        let text = std::fs::read_to_string(cfg.join("settings.toml")).unwrap();
        assert_eq!(text, "# My settings\n\n[editor]\n# bigger is better\nfontSize = 16 # pt\nsoftWrap = true\n");

        let s = store.set(SettingsScope::Global, "appearance.theme", json!("light")).unwrap();
        assert_eq!(s.appearance.theme, "light");
        let s = store.set(SettingsScope::Global, "files.exclude", json!(["**/dist"])).unwrap();
        assert_eq!(s.files.exclude, vec!["**/dist".to_string()]);
        let s = store.set(SettingsScope::Global, "editor.lineHeight", json!(22.5)).unwrap();
        assert_eq!(s.editor.line_height, 22.5);
        // Map-valued setting whose keys contain dots, replaced as a whole.
        let s = store
            .set(
                SettingsScope::Global,
                "appearance.statusBarWidgets",
                json!({"perf.memory": true, "editor.caret": false}),
            )
            .unwrap();
        assert_eq!(s.appearance.status_bar_widgets.get("perf.memory"), Some(&true));
        let s =
            store.set(SettingsScope::Global, "appearance.statusBarWidgets", json!({"editor.caret": false})).unwrap();
        assert_eq!(s.appearance.status_bar_widgets.len(), 1);

        // Project layer is created on demand and wins.
        let s = store.set(SettingsScope::Project, "editor.fontSize", json!(12)).unwrap();
        assert_eq!(s.editor.font_size, 12.0);
        assert_eq!(std::fs::read_to_string(proj.join(".openidea/settings.toml")).unwrap(), "[editor]\nfontSize = 12\n");
        let s = store.set(SettingsScope::Project, "editor.fontSize", json!(null)).unwrap();
        assert_eq!(s.editor.font_size, 16.0);

        let err = |key: &str, v: Json| store.set(SettingsScope::Global, key, v).unwrap_err().kind;
        assert_eq!(err("editor.fontSize", json!("huge")), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(err("editor.nope", json!(1)), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(err("editor..x", json!(1)), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(store.effective().editor.font_size, 16.0);

        let reloaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(reloaded, store.effective());
    }
}
