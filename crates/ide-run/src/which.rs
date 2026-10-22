//! Executable lookup on a search path. On Windows a bare name resolves through
//! `PATHEXT` (`kotlinc` → `kotlinc.bat`, `npx` → `npx.cmd`), which
//! `std::process::Command` does not do (it only appends `.exe`).

use std::ffi::OsStr;
use std::path::PathBuf;

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// File names `name` may have on disk. Unix: the name itself. Windows: the
/// name when it already ends in a `PATHEXT` extension, else the name with each
/// extension (an extensionless file is not executable there).
pub fn executable_names(name: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec![name.to_owned()];
    }
    let exts: Vec<&str> = pathext
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(str::trim)
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .collect();
    let lower = name.to_ascii_lowercase();
    if exts.iter().any(|e| lower.ends_with(&e.to_ascii_lowercase())) {
        return vec![name.to_owned()];
    }
    exts.iter().map(|e| format!("{name}{}", e.to_ascii_lowercase())).collect()
}

/// First `search` directory holding `name` (see [`executable_names`]).
pub fn find_executable_in(name: &str, search: &OsStr, windows: bool, pathext: Option<&str>) -> Option<PathBuf> {
    let names = executable_names(name, windows, pathext);
    std::env::split_paths(search)
        .filter(|d| !d.as_os_str().is_empty())
        .find_map(|dir| names.iter().map(|n| dir.join(n)).find(|p| p.is_file()))
}

/// [`find_executable_in`] for this platform (`PATHEXT` from the environment).
pub fn find_executable(name: &str, search: &OsStr) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").ok();
    find_executable_in(name, search, cfg!(windows), pathext.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_uses_the_name_as_is() {
        assert_eq!(executable_names("kotlinc", false, Some(".BAT")), ["kotlinc"]);
    }

    #[test]
    fn windows_appends_pathext_extensions() {
        assert_eq!(
            executable_names("kotlinc", true, None),
            ["kotlinc.com", "kotlinc.exe", "kotlinc.bat", "kotlinc.cmd"]
        );
        assert_eq!(executable_names("npx", true, Some(".EXE;.CMD;;")), ["npx.exe", "npx.cmd"]);
        assert_eq!(executable_names("npx", true, Some("  ")), executable_names("npx", true, None));
        // Already has an executable extension (any case): only that file.
        assert_eq!(executable_names("rustc.EXE", true, None), ["rustc.EXE"]);
        assert_eq!(executable_names("gradlew.bat", true, None), ["gradlew.bat"]);
        // A dot that is not an executable extension (`clang++`, `python3.12`).
        assert_eq!(executable_names("python3.12", true, Some(".EXE")), ["python3.12.exe"]);
    }

    #[test]
    fn finds_batch_files_and_skips_extensionless_scripts_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        // `node_modules/.bin` style: a POSIX script next to its `.cmd` shim.
        std::fs::write(a.join("tsx"), "#!/bin/sh\n").unwrap();
        std::fs::write(b.join("tsx.cmd"), "@echo off\n").unwrap();
        std::fs::write(b.join("kotlinc.bat"), "@echo off\n").unwrap();
        let search = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_executable_in("tsx", &search, true, None), Some(b.join("tsx.cmd")));
        assert_eq!(find_executable_in("kotlinc", &search, true, None), Some(b.join("kotlinc.bat")));
        assert_eq!(find_executable_in("tsx", &search, false, None), Some(a.join("tsx")));
        assert_eq!(find_executable_in("kotlinc", &search, false, None), None);
        assert_eq!(find_executable_in("nope", &search, true, None), None);
    }
}
