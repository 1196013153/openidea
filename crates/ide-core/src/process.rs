//! Child-process helpers shared by every crate that spawns tools.

use std::ffi::{OsStr, OsString};
use std::process::Command;
use std::sync::OnceLock;

/// Windows `CREATE_NO_WINDOW` creation flag, for call sites that combine it
/// with other flags. Prefer [`no_window`] otherwise.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keeps a console child (java, node, curl, a language server, ...) from
/// opening its own console window on Windows. Release builds use the GUI
/// subsystem, so without this every spawn flashes a `cmd` window. A no-op
/// elsewhere. For a `tokio::process::Command`, pass `cmd.as_std_mut()`.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

static SHELL_ENV: OnceLock<Vec<(OsString, OsString)>> = OnceLock::new();

/// Records the login shell's environment, read once at startup off the main thread.
pub fn set_shell_env(vars: Vec<(OsString, OsString)>) {
    let _ = SHELL_ENV.set(vars);
}

/// The login shell's variables this process lacks: an app started from Finder/Dock gets only
/// PATH from the shell, not what rc files export (API keys and provider switches, SDK homes...).
/// Apply before a call site's own variables so those win. Empty until the shell has been read.
pub fn shell_env() -> impl Iterator<Item = (&'static OsStr, &'static OsStr)> {
    SHELL_ENV
        .get()
        .into_iter()
        .flatten()
        .filter(|(k, _)| std::env::var_os(k).is_none())
        .map(|(k, v)| (k.as_os_str(), v.as_os_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_env_adds_only_what_the_process_lacks() {
        set_shell_env(vec![("OPENIDEA_SHELL_ONLY_VAR".into(), "1".into()), ("PATH".into(), "/from/shell".into())]);
        let vars: Vec<_> = shell_env().collect();
        assert_eq!(vars, [(OsStr::new("OPENIDEA_SHELL_ONLY_VAR"), OsStr::new("1"))]);
    }
}
