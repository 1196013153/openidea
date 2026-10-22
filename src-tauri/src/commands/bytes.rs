//! Raw file bytes for the image viewer and hex view (see `ide_vfs::bytes`).

use crate::commands::doc::blocking;
use ide_core::IdeResult;
use ide_vfs::{ByteRange, FileProbe};
use std::path::PathBuf;

/// Size and text/binary classification, from the file's head only.
#[tauri::command]
#[specta::specta]
pub async fn fs_probe(path: PathBuf) -> IdeResult<FileProbe> {
    blocking(move || ide_vfs::probe(&path)).await
}

/// Up to `len` bytes from `offset` (capped per call), base64-encoded.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_range(path: PathBuf, offset: u64, len: u32) -> IdeResult<ByteRange> {
    blocking(move || ide_vfs::read_range(&path, offset, len)).await
}

/// An image file as a `data:` URL.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_image(path: PathBuf) -> IdeResult<String> {
    blocking(move || ide_vfs::read_data_url(&path)).await
}
