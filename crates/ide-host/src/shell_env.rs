//! GUI apps launched from Finder/Dock get a minimal PATH. Language servers,
//! git, package managers and run configurations need the user's real one, so
//! on macOS/Linux we take PATH from the login shell at startup.
//!
//! Spawning an interactive login shell costs ~1 s with typical rc files, so the
//! value is cached: a warm start uses the cached PATH immediately and refreshes
//! the cache in the background for the next launch.

#[cfg(unix)]
/// Returns a refresh to run once the environment is final (it spawns a
/// thread, and `set_var` must not race with other threads).
pub fn inherit_login_shell_path(identifier: &str) -> Option<impl FnOnce() + use<>> {
    use std::time::Duration;

    if std::env::var_os("OPENIDEA_SKIP_SHELL_ENV").is_some() {
        return None;
    }
    let cache = dirs::cache_dir().map(|d| d.join(identifier).join("login-path"));
    let cached = cache.as_ref().and_then(|c| std::fs::read_to_string(c).ok()).filter(|p| !p.trim().is_empty());
    let refresh = cached.is_some();
    let path = match cached {
        Some(path) => path,
        None => {
            // Slow shell rc files must not delay the first start indefinitely.
            let fresh = read_login_path(Duration::from_secs(3))?;
            if let Some(cache) = &cache {
                write_cache(cache, &fresh);
            }
            fresh
        }
    };
    // SAFETY: called at startup before any other thread reads the environment.
    unsafe { std::env::set_var("PATH", path.trim()) };
    let cache = cache.filter(|_| refresh)?;
    Some(move || {
        std::thread::spawn(move || {
            if let Some(fresh) = read_login_path(Duration::from_secs(10)) {
                write_cache(&cache, &fresh);
            }
        });
    })
}

#[cfg(unix)]
fn write_cache(cache: &std::path::Path, path: &str) {
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(cache, path);
}

#[cfg(unix)]
fn read_login_path(timeout: std::time::Duration) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    const MARK: &str = "__OPENIDEA_PATH__";
    let mut child = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                tracing::warn!("timed out reading PATH from {shell}");
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.split(MARK).nth(1).filter(|p| !p.is_empty()).map(str::to_owned)
}

#[cfg(not(unix))]
pub fn inherit_login_shell_path(_identifier: &str) -> Option<fn()> {
    None
}
