//! Starting jdtls on the JVM directly instead of through its launcher scripts.
//!
//! The release ships `bin/jdtls` (Python), `bin/jdtls.py` and, for Windows,
//! `bin/jdtls.bat`, which runs `python` and then `pause`. Each needs a Python
//! interpreter; without one the batch file prints `pause`'s prompt in the console
//! code page and exits. The command line the script builds is reproduced here, so
//! only a JDK is needed.

use crate::java::{Jdk, jdk_at};
use ide_language::LanguageServerConfig;
use std::path::{Path, PathBuf};

/// The parts of a jdtls install the JVM is started with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JdtlsInstall {
    /// `plugins/org.eclipse.equinox.launcher_<version>.jar`.
    pub launcher: PathBuf,
    /// The shared, read-only OSGi configuration for this platform (`config_win`, `config_mac_arm`…).
    pub config: PathBuf,
}

/// Names of the release's launcher scripts; anything else is the user's own wrapper.
const SCRIPTS: &[&str] = &["jdtls", "jdtls.bat", "jdtls.cmd", "jdtls.py"];

/// The directory with `plugins/` of the jdtls `executable` belongs to (`<home>/bin/jdtls`,
/// or Homebrew's `<prefix>/bin/jdtls` wrapper with the install under `libexec`).
pub fn jdtls_home(executable: &Path) -> Option<PathBuf> {
    let exe = dunce::canonicalize(executable).ok()?;
    let home = exe.parent()?.parent()?;
    [home.to_path_buf(), home.join("libexec")].into_iter().find(|h| h.join("plugins").is_dir())
}

/// Shared configuration directories to try, best first, for `os` / `arch`
/// (`std::env::consts` values), as the release names them.
pub fn config_dir_names(os: &str, arch: &str) -> Vec<String> {
    let base = match os {
        "windows" => "config_win",
        "macos" => "config_mac",
        _ => "config_linux",
    };
    let mut names = Vec::new();
    if arch == "aarch64" {
        names.push(format!("{base}_arm"));
    }
    names.push(base.to_owned());
    names
}

/// The launcher jar and configuration of the install at `home`, when it has the
/// release layout.
pub fn find_install(home: &Path, os: &str, arch: &str) -> Option<JdtlsInstall> {
    let plugins = home.join("plugins");
    let unversioned = plugins.join("org.eclipse.equinox.launcher.jar");
    let launcher = if unversioned.is_file() {
        unversioned
    } else {
        let mut jars: Vec<PathBuf> = std::fs::read_dir(&plugins)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                    // Not the native fragments (`org.eclipse.equinox.launcher.win32.win32.x86_64_…`).
                    n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar")
                })
            })
            .collect();
        jars.sort();
        jars.pop()?
    };
    let config =
        config_dir_names(os, arch).into_iter().map(|n| home.join(n)).find(|d| d.join("config.ini").is_file())?;
    Some(JdtlsInstall { launcher, config })
}

/// Arguments meant for the launcher script, sorted out.
#[derive(Debug, Default, PartialEq, Eq)]
struct ScriptArgs {
    jvm: Vec<String>,
    java: Option<String>,
    data: Option<String>,
    rest: Vec<String>,
}

fn split_script_args(args: &[String]) -> ScriptArgs {
    let mut out = ScriptArgs::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(v) = a.strip_prefix("--jvm-arg=") {
            out.jvm.push(v.to_owned());
        } else if a == "--jvm-arg" {
            out.jvm.extend(it.next().cloned());
        } else if let Some(v) = a.strip_prefix("--java-executable=") {
            out.java = Some(v.to_owned());
        } else if a == "--java-executable" {
            out.java = it.next().cloned();
        } else if a == "-data" {
            out.data = it.next().cloned();
        } else if let Some(v) = a.strip_prefix("-data=") {
            out.data = Some(v.to_owned());
        } else if a != "--validate-java-version" && a != "--no-validate-java-version" {
            out.rest.push(a.clone());
        }
    }
    out
}

/// Memory and GC options added unless the user's JVM arguments set their own,
/// VS Code's Java extension defaults (`java.jdt.ls.vmargs`) instead of the script's
/// `-Xms1G` and the JVM's default heap limit (a quarter of physical memory).
/// G1 with a periodic GC hands the heap grown while importing a project back to
/// the OS once the server is idle (other collectors only shrink during a GC, which
/// an idle server never runs); its tuning flags only apply to it, so a GC of the
/// user's choice drops the whole group. `-Xlog:disable` keeps JVM warnings
/// off stdout, which carries the LSP stream.
pub fn default_jvm_args(user_jvm: &[String]) -> Vec<String> {
    let user_sets = |prefixes: &[&str]| user_jvm.iter().any(|a| prefixes.iter().any(|p| a.starts_with(p)));
    let user_gc = user_jvm.iter().any(|a| a.starts_with("-XX:+Use") && a.ends_with("GC"));
    let mut args: Vec<&str> = Vec::new();
    if !user_gc {
        args.extend([
            "-XX:+UseG1GC",
            "-XX:G1PeriodicGCInterval=60000",
            "-XX:MinHeapFreeRatio=10",
            "-XX:MaxHeapFreeRatio=30",
        ]);
    }
    args.push("-Dsun.zip.disableMemoryMapping=true");
    // `-Xmx` wins over the RAM percentages whatever the order, so those count too.
    if !user_sets(&["-Xmx", "-XX:MaxHeapSize=", "-XX:MaxRAMPercentage=", "-XX:MaxRAM="]) {
        args.push("-Xmx2G");
    }
    if !user_sets(&["-Xms", "-XX:InitialHeapSize=", "-XX:InitialRAMPercentage="]) {
        args.push("-Xms100m");
    }
    args.push("-Xlog:disable");
    args.into_iter().map(String::from).collect()
}

/// The JVM command line `bin/jdtls` builds: its system properties, the memory
/// and GC [defaults](default_jvm_args), its module options, the user's
/// `--jvm-arg`s (last, so they win), then the Equinox launcher with `-data`.
pub fn java_args(install: &JdtlsInstall, java_major: u32, script_args: &[String]) -> Vec<String> {
    let parsed = split_script_args(script_args);
    let mut args: Vec<String> = Vec::new();
    if java_major >= 24 {
        args.extend(["-Djdk.xml.maxGeneralEntitySizeLimit=0".into(), "-Djdk.xml.totalEntitySizeLimit=0".into()]);
    }
    args.extend(
        [
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dosgi.checkConfiguration=true",
        ]
        .map(String::from),
    );
    args.push(format!("-Dosgi.sharedConfiguration.area={}", install.config.to_string_lossy()));
    args.extend(
        ["-Dosgi.sharedConfiguration.area.readOnly=true", "-Dosgi.configuration.cascaded=true"].map(String::from),
    );
    args.extend(default_jvm_args(&parsed.jvm));
    args.extend(
        [
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
        ]
        .map(String::from),
    );
    args.extend(parsed.jvm);
    args.extend(["-jar".to_owned(), install.launcher.to_string_lossy().into_owned()]);
    if let Some(data) = parsed.data {
        args.extend(["-data".to_owned(), data]);
    }
    // Without it the Equinox launcher loads its Cocoa library for a splash screen, which
    // checks the JVM in as a foreground app: a second Dock icon named after the IDE.
    let nosplash = !parsed.rest.iter().any(|a| a == "-nosplash");
    args.extend(parsed.rest);
    if nosplash {
        args.push("-nosplash".to_owned());
    }
    args
}

/// Rewrites a jdtls launch (`command` = the release's script, `JAVA_HOME` chosen by
/// [`crate::java::configure_jdtls`]) to start `java` directly. Left unchanged when the
/// command is someone's own wrapper, the install has another layout, or no JDK is set
/// (the launch then reports why).
pub fn launch_directly(cfg: &mut LanguageServerConfig) {
    if cfg.name != "jdtls" || cfg.launch_error.is_some() {
        return;
    }
    let search = cfg.env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
    let Some(script) = search.and_then(|s| ide_run::which::find_executable(&cfg.command, &s)) else { return };
    let is_script = dunce::canonicalize(&script)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()))
        .is_some_and(|n| SCRIPTS.contains(&n.as_str()));
    if !is_script {
        return;
    }
    let Some(install) =
        jdtls_home(&script).and_then(|h| find_install(&h, std::env::consts::OS, std::env::consts::ARCH))
    else {
        return;
    };
    let own_java = split_script_args(&cfg.args).java.map(PathBuf::from);
    let jdk: Option<(PathBuf, Jdk)> = match own_java {
        Some(java) => java.parent().and_then(Path::parent).and_then(jdk_at).map(|jdk| (java, jdk)),
        None => cfg.env.get("JAVA_HOME").and_then(|h| jdk_at(Path::new(h))).map(|jdk| {
            let java = crate::java::java_executable(&jdk.home);
            (java, jdk)
        }),
    };
    let Some((java, jdk)) = jdk.filter(|(java, _)| java.is_file()) else { return };
    cfg.args = java_args(&install, jdk.major, &cfg.args);
    cfg.command = java.to_string_lossy().into_owned();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// What [`crate::java::configure_jdtls`] and the settings pass to the script.
    fn script_args(data: &str, agent: &str) -> Vec<String> {
        strings(&[
            "--jvm-arg=-Xmx2G",
            "-data",
            data,
            "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false",
            &format!("--jvm-arg=-javaagent:{agent}"),
        ])
    }

    #[test]
    fn windows_command_line() {
        // The reporter's layout: a managed install under %APPDATA%, JDK 25, a user name with a space and CJK.
        let tools = r"C:\Users\张 三\AppData\Roaming\ai.l0ng.openidea\tools\jdtls";
        let install = JdtlsInstall {
            launcher: PathBuf::from(format!(r"{tools}\plugins\org.eclipse.equinox.launcher_1.7.0.v20250424-1814.jar")),
            config: PathBuf::from(format!(r"{tools}\config_win")),
        };
        let data = r"C:\Users\张 三\AppData\Roaming\ai.l0ng.openidea\lsp\jdtls\0123456789abcdef";
        let agent = r"C:\Users\张 三\AppData\Roaming\ai.l0ng.openidea\tools\lombok\bin\lombok.jar";
        let args = java_args(&install, 25, &script_args(data, agent));
        assert_eq!(
            args,
            strings(&[
                "-Djdk.xml.maxGeneralEntitySizeLimit=0",
                "-Djdk.xml.totalEntitySizeLimit=0",
                "-Declipse.application=org.eclipse.jdt.ls.core.id1",
                "-Dosgi.bundles.defaultStartLevel=4",
                "-Declipse.product=org.eclipse.jdt.ls.core.product",
                "-Dosgi.checkConfiguration=true",
                &format!(r"-Dosgi.sharedConfiguration.area={tools}\config_win"),
                "-Dosgi.sharedConfiguration.area.readOnly=true",
                "-Dosgi.configuration.cascaded=true",
                "-XX:+UseG1GC",
                "-XX:G1PeriodicGCInterval=60000",
                "-XX:MinHeapFreeRatio=10",
                "-XX:MaxHeapFreeRatio=30",
                "-Dsun.zip.disableMemoryMapping=true",
                "-Xms100m",
                "-Xlog:disable",
                "--add-modules=ALL-SYSTEM",
                "--add-opens",
                "java.base/java.util=ALL-UNNAMED",
                "--add-opens",
                "java.base/java.lang=ALL-UNNAMED",
                "-Xmx2G",
                "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
                &format!("-javaagent:{agent}"),
                "-jar",
                &format!(r"{tools}\plugins\org.eclipse.equinox.launcher_1.7.0.v20250424-1814.jar"),
                "-data",
                data,
                "-nosplash",
            ])
        );
    }

    #[test]
    fn unix_command_line() {
        let install = JdtlsInstall {
            launcher: PathBuf::from(
                "/Users/me/Library/Application Support/ai.l0ng.openidea/tools/jdtls/plugins/org.eclipse.equinox.launcher_1.7.0.jar",
            ),
            config: PathBuf::from("/Users/me/Library/Application Support/ai.l0ng.openidea/tools/jdtls/config_mac_arm"),
        };
        let args = java_args(
            &install,
            21,
            &strings(&["--jvm-arg", "-Dlog.level=ALL", "--no-validate-java-version", "-data", "/d", "--extra"]),
        );
        assert_eq!(args[0], "-Declipse.application=org.eclipse.jdt.ls.core.id1", "no JDK 24+ flags on 21");
        assert!(args.contains(&"-Dosgi.sharedConfiguration.area=/Users/me/Library/Application Support/ai.l0ng.openidea/tools/jdtls/config_mac_arm".to_owned()));
        assert_eq!(
            args[args.len() - 8..],
            strings(&[
                "java.base/java.lang=ALL-UNNAMED",
                "-Dlog.level=ALL",
                "-jar",
                "/Users/me/Library/Application Support/ai.l0ng.openidea/tools/jdtls/plugins/org.eclipse.equinox.launcher_1.7.0.jar",
                "-data",
                "/d",
                "--extra",
                "-nosplash",
            ])
        );
        // Given by the user already: not repeated.
        let own = java_args(&install, 21, &strings(&["-data", "/d", "-nosplash"]));
        assert_eq!(own.iter().filter(|a| *a == "-nosplash").count(), 1);
        assert!(!args.iter().any(|a| a.contains("validate-java-version")));
    }

    #[test]
    fn default_memory_and_gc_options() {
        assert_eq!(
            default_jvm_args(&[]),
            strings(&[
                "-XX:+UseG1GC",
                "-XX:G1PeriodicGCInterval=60000",
                "-XX:MinHeapFreeRatio=10",
                "-XX:MaxHeapFreeRatio=30",
                "-Dsun.zip.disableMemoryMapping=true",
                "-Xmx2G",
                "-Xms100m",
                "-Xlog:disable",
            ])
        );
        // Unrelated user options keep every default.
        assert_eq!(default_jvm_args(&strings(&["-javaagent:/l.jar", "-Dlog.level=ALL"])), default_jvm_args(&[]));
    }

    #[test]
    fn user_memory_and_gc_options_replace_the_defaults() {
        let own_max = default_jvm_args(&strings(&["-Xmx4g"]));
        assert!(!own_max.iter().any(|a| a.starts_with("-Xmx")));
        assert!(own_max.contains(&"-Xms100m".to_owned()) && own_max.contains(&"-XX:+UseG1GC".to_owned()));
        let percentage = default_jvm_args(&strings(&["-XX:MaxRAMPercentage=10"]));
        assert!(!percentage.iter().any(|a| a.starts_with("-Xmx")));

        let own_min = default_jvm_args(&strings(&["-Xms512m"]));
        assert!(!own_min.iter().any(|a| a.starts_with("-Xms")));
        assert!(own_min.contains(&"-Xmx2G".to_owned()));

        let parallel = default_jvm_args(&strings(&["-XX:+UseParallelGC"]));
        assert_eq!(
            parallel,
            strings(&["-Dsun.zip.disableMemoryMapping=true", "-Xmx2G", "-Xms100m", "-Xlog:disable"]),
            "G1's tuning is dropped with it"
        );
        assert!(!default_jvm_args(&strings(&["-XX:+UseZGC"])).iter().any(|a| a.starts_with("-XX:")));
    }

    #[test]
    fn defaults_come_after_system_properties_and_before_the_users_options() {
        let install =
            JdtlsInstall { launcher: PathBuf::from("/j/plugins/launcher.jar"), config: PathBuf::from("/j/config_mac") };
        let args = java_args(&install, 25, &strings(&["--jvm-arg=-Xmx4g", "--jvm-arg=-XX:+UseZGC", "-data", "/d"]));
        let at = |a: &str| args.iter().position(|x| x == a).unwrap_or_else(|| panic!("{a} missing"));
        assert!(at("-Dosgi.configuration.cascaded=true") < at("-Dsun.zip.disableMemoryMapping=true"));
        assert!(at("-Xlog:disable") < at("--add-modules=ALL-SYSTEM"));
        assert!(at("--add-modules=ALL-SYSTEM") < at("-Xmx4g"));
        assert!(at("-Xmx4g") < at("-XX:+UseZGC") && at("-XX:+UseZGC") < at("-jar"));
        assert!(
            !args.iter().any(|a| a == "-Xmx2G"
                || a == "-XX:+UseG1GC"
                || a == "-XX:G1PeriodicGCInterval=60000"
                || a == "-Xms1G")
        );
        assert!(args.contains(&"-Xms100m".to_owned()));
    }

    #[test]
    fn config_dirs_per_platform() {
        assert_eq!(config_dir_names("windows", "x86_64"), ["config_win"]);
        assert_eq!(config_dir_names("windows", "aarch64"), ["config_win_arm", "config_win"]);
        assert_eq!(config_dir_names("macos", "aarch64"), ["config_mac_arm", "config_mac"]);
        assert_eq!(config_dir_names("linux", "x86_64"), ["config_linux"]);
    }

    #[test]
    fn finds_the_launcher_and_configuration_of_a_release_layout() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::create_dir_all(home.join("plugins")).unwrap();
        for jar in [
            "org.eclipse.equinox.launcher_1.7.0.v20250424-1814.jar",
            "org.eclipse.equinox.launcher.win32.win32.x86_64_1.2.1300.v20250331-1702.jar",
            "org.eclipse.jdt.ls.core_1.50.0.jar",
        ] {
            std::fs::write(home.join("plugins").join(jar), "").unwrap();
        }
        assert_eq!(find_install(home, "windows", "x86_64"), None, "no configuration");
        for config in ["config_win", "config_mac", "config_mac_arm"] {
            std::fs::create_dir_all(home.join(config)).unwrap();
            std::fs::write(home.join(config).join("config.ini"), "").unwrap();
        }
        let win = find_install(home, "windows", "x86_64").unwrap();
        assert_eq!(win.launcher, home.join("plugins/org.eclipse.equinox.launcher_1.7.0.v20250424-1814.jar"));
        assert_eq!(win.config, home.join("config_win"));
        assert_eq!(find_install(home, "windows", "aarch64").unwrap().config, home.join("config_win"));
        assert_eq!(find_install(home, "macos", "aarch64").unwrap().config, home.join("config_mac_arm"));
    }

    #[cfg(unix)]
    #[test]
    fn rewrites_the_release_script_to_java() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("jdtls");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir_all(home.join("plugins")).unwrap();
        std::fs::write(home.join("plugins/org.eclipse.equinox.launcher_1.7.0.jar"), "").unwrap();
        for config in config_dir_names(std::env::consts::OS, std::env::consts::ARCH) {
            std::fs::create_dir_all(home.join(&config)).unwrap();
            std::fs::write(home.join(&config).join("config.ini"), "").unwrap();
        }
        let script = home.join("bin/jdtls");
        std::fs::write(&script, "#!/usr/bin/env python3\n").unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let jdk = dir.path().join("jdk-25");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"25.0.1\"\n").unwrap();
        std::fs::write(jdk.join("bin/java"), "").unwrap();

        let cfg = |command: &str| -> LanguageServerConfig {
            let mut cfg: LanguageServerConfig =
                toml::from_str(&format!("name = \"jdtls\"\ncommand = {command:?}")).unwrap();
            cfg.env.insert("PATH".into(), home.join("bin").to_string_lossy().into_owned());
            cfg.env.insert("JAVA_HOME".into(), jdk.to_string_lossy().into_owned());
            cfg.args = strings(&["-data", "/ws", "--jvm-arg=-Xmx1G"]);
            cfg
        };
        let mut direct = cfg("jdtls");
        launch_directly(&mut direct);
        let java = dunce::canonicalize(&jdk).unwrap().join("bin/java");
        assert_eq!(Path::new(&direct.command), java);
        assert_eq!(direct.args[0], "-Djdk.xml.maxGeneralEntitySizeLimit=0");
        assert!(direct.args.iter().any(|a| a == "-Xmx1G"));
        let jar = direct.args.iter().position(|a| a == "-jar").unwrap();
        assert!(direct.args[jar + 1].ends_with("org.eclipse.equinox.launcher_1.7.0.jar"));
        assert_eq!(direct.args[jar + 2..], strings(&["-data", "/ws", "-nosplash"]));

        // Someone's own wrapper, or no usable JDK: the command is kept.
        std::fs::write(home.join("bin/my-jdtls"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(home.join("bin/my-jdtls"), std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let mut own = cfg("my-jdtls");
        launch_directly(&mut own);
        assert_eq!(own.command, "my-jdtls");
        let mut no_jdk = cfg("jdtls");
        no_jdk.env.remove("JAVA_HOME");
        launch_directly(&mut no_jdk);
        assert_eq!(no_jdk.command, "jdtls");
        let mut failing = cfg("jdtls");
        failing.launch_error = Some("needs JDK 25".into());
        launch_directly(&mut failing);
        assert_eq!(failing.command, "jdtls");
    }
}
