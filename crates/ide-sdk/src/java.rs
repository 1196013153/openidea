//! Installed JDKs and the jdtls launch configuration that depends on them.

use crate::apply::merge_init_options;
use crate::home_dir;
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A JDK home and its feature version (8, 11, 17, 21…).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jdk {
    pub major: u32,
    pub home: PathBuf,
}

/// `JAVA_VERSION="21.0.3"` (or `"1.8.0_372"`) from a JDK's `release` file.
pub fn parse_release(release: &str) -> Option<u32> {
    let line = release.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    let v = line.trim().trim_matches('"');
    let mut parts = v.split(['.', '_', '-', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 { parts.next()?.parse().ok() } else { Some(first) }
}

fn jdk_at(home: &Path) -> Option<Jdk> {
    let release = std::fs::read_to_string(home.join("release")).ok()?;
    if !home.join("bin").join(crate::exe("java")).is_file() {
        return None;
    }
    Some(Jdk {
        major: parse_release(&release)?,
        home: dunce::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()),
    })
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> =
        std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    out.sort();
    out
}

/// JDK homes in the usual install locations (macOS `JavaVirtualMachines`,
/// `/usr/lib/jvm`, SDKMAN, IDEA's `~/.jdks`, Homebrew), `JAVA_HOME` first.
fn scan() -> Vec<Jdk> {
    let mut homes: Vec<PathBuf> = Vec::new();
    if let Some(h) = std::env::var_os("JAVA_HOME") {
        homes.push(PathBuf::from(h));
    }
    let home = home_dir();
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/Library/Java/JavaVirtualMachines"),
        PathBuf::from("/usr/lib/jvm"),
        PathBuf::from("/opt/homebrew/opt"),
        PathBuf::from("/usr/local/opt"),
    ];
    if let Some(h) = &home {
        roots.extend([h.join("Library/Java/JavaVirtualMachines"), h.join(".jdks"), h.join(".sdkman/candidates/java")]);
    }
    for root in roots {
        for dir in children(&root) {
            homes.extend([dir.join("Contents/Home"), dir.join("libexec/openjdk.jdk/Contents/Home"), dir]);
        }
    }
    let mut out: Vec<Jdk> = Vec::new();
    for h in homes {
        if let Some(jdk) = jdk_at(&h)
            && !out.iter().any(|j| j.home == jdk.home)
        {
            out.push(jdk);
        }
    }
    out
}

/// Installed JDKs (scanned once per process).
pub fn installed_jdks() -> &'static [Jdk] {
    static JDKS: OnceLock<Vec<Jdk>> = OnceLock::new();
    JDKS.get_or_init(scan)
}

/// jdtls `java.configuration.runtimes`: one JDK per Java version (the first
/// found, i.e. `JAVA_HOME` wins), named after its execution environment, so a
/// project targeting Java 21 compiles against a JDK 21 rather than the JDK
/// jdtls itself runs on.
pub fn runtimes(jdks: &[Jdk]) -> Vec<serde_json::Value> {
    let mut by_major: BTreeMap<u32, &Jdk> = BTreeMap::new();
    for j in jdks {
        by_major.entry(j.major).or_insert(j);
    }
    by_major
        .into_iter()
        .filter(|(major, _)| *major >= 8)
        .map(|(major, j)| {
            let name = if major == 8 { "JavaSE-1.8".to_owned() } else { format!("JavaSE-{major}") };
            json!({ "name": name, "path": j.home.to_string_lossy() })
        })
        .collect()
}

/// Stable FNV-1a hash of a path, for per-workspace directories.
fn path_key(p: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in p.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

const METADATA_PROPERTY: &str = "java.import.generatesMetadataFilesAtProjectRoot";

/// jdtls: its Eclipse workspace (`-data`) lives under the IDE's data
/// directory, one per server root, and no Eclipse metadata is written into
/// the project; installed JDKs are registered as runtimes and `bundles`
/// (e.g. the java-debug plugin jar) are loaded into the server.
pub fn configure_jdtls(
    cfg: &mut LanguageServerConfig,
    server_root: &Path,
    data_dir: &Path,
    jdks: &[Jdk],
    bundles: &[PathBuf],
) {
    if cfg.name != "jdtls" {
        return;
    }
    if !cfg.args.iter().any(|a| a == "-data") {
        let dir = data_dir.join("lsp").join("jdtls").join(path_key(server_root));
        cfg.args.extend(["-data".to_owned(), dir.to_string_lossy().into_owned()]);
    }
    // jdtls reads this one as a system property (its file-system bundle
    // relocates .project / .classpath / .settings into the workspace).
    if !cfg.args.iter().any(|a| a.contains(METADATA_PROPERTY)) {
        cfg.args.push(format!("--jvm-arg=-D{METADATA_PROPERTY}=false"));
    }
    let runtimes = runtimes(jdks);
    if !runtimes.is_empty() {
        merge_init_options(cfg, json!({ "settings": { "java": { "configuration": { "runtimes": runtimes } } } }));
    }
    if !bundles.is_empty() {
        let bundles: Vec<String> = bundles.iter().map(|b| b.to_string_lossy().into_owned()).collect();
        merge_init_options(cfg, json!({ "bundles": bundles }));
    }
}

/// The `java` launcher of a JDK home.
pub fn java_executable(home: &Path) -> PathBuf {
    home.join("bin").join(crate::exe("java"))
}

/// The JDK to run a project targeting Java `release` with: that exact version,
/// else the oldest newer one, else the newest installed (`None`: any, newest).
pub fn pick_jdk(jdks: &[Jdk], release: Option<u32>) -> Option<&Jdk> {
    let newest = jdks.iter().max_by_key(|j| j.major);
    let Some(release) = release else { return newest };
    jdks.iter()
        .find(|j| j.major == release)
        .or_else(|| jdks.iter().filter(|j| j.major > release).min_by_key(|j| j.major))
        .or(newest)
}

/// Java version a Maven / Gradle module targets: `<java.version>`,
/// `<maven.compiler.release|source|target>` / `<release>`, Gradle toolchains
/// (`JavaLanguageVersion.of(21)`) or `sourceCompatibility`.
pub fn project_java_version(module_dir: &Path) -> Option<u32> {
    let read = |name: &str| std::fs::read_to_string(module_dir.join(name)).ok();
    if let Some(pom) = read("pom.xml") {
        for tag in
            ["java.version", "maven.compiler.release", "release", "maven.compiler.source", "maven.compiler.target"]
        {
            if let Some(v) = xml_value(&pom, tag).and_then(|v| parse_java_version(&v)) {
                return Some(v);
            }
        }
    }
    for name in ["build.gradle.kts", "build.gradle"] {
        let Some(text) = read(name) else { continue };
        if let Some(i) = text.find("JavaLanguageVersion.of(") {
            let rest = &text[i + "JavaLanguageVersion.of(".len()..];
            if let Some(v) = parse_java_version(rest.split(')').next().unwrap_or_default()) {
                return Some(v);
            }
        }
        for key in ["sourceCompatibility", "targetCompatibility"] {
            if let Some(i) = text.find(key) {
                let rest = text[i + key.len()..].trim_start_matches([' ', '=', '\t']);
                let token: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != '\n')
                    .collect::<String>()
                    .trim_matches(['\'', '"'])
                    .replace("JavaVersion.VERSION_", "");
                if let Some(v) = parse_java_version(&token.replace('_', ".")) {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn xml_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find('<')?;
    Some(text[start..start + end].trim().to_owned())
}

/// `21`, `"17"`, `1.8`, `'11'` → feature version.
fn parse_java_version(v: &str) -> Option<u32> {
    let v = v.trim().trim_matches(['"', '\'']);
    let mut parts = v.split('.');
    let first: u32 = parts.next()?.trim().parse().ok()?;
    if first == 1 { parts.next()?.trim().parse().ok() } else { Some(first) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_versions() {
        assert_eq!(parse_release("IMPLEMENTOR=\"x\"\nJAVA_VERSION=\"21.0.3\"\n"), Some(21));
        assert_eq!(parse_release("JAVA_VERSION=\"1.8.0_372\""), Some(8));
        assert_eq!(parse_release("JAVA_VERSION=\"25\""), Some(25));
        assert_eq!(parse_release("OTHER=1"), None);
    }

    #[test]
    fn jdtls_workspace_and_runtimes() {
        let mut cfg: LanguageServerConfig = toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap();
        let jdks = [
            Jdk { major: 25, home: PathBuf::from("/jdk25") },
            Jdk { major: 21, home: PathBuf::from("/jdk21a") },
            Jdk { major: 21, home: PathBuf::from("/jdk21b") },
            Jdk { major: 8, home: PathBuf::from("/jdk8") },
        ];
        let bundles = [PathBuf::from("/tools/java-debug/bin/com.microsoft.java.debug.plugin.jar")];
        configure_jdtls(&mut cfg, Path::new("/p/demo"), Path::new("/data"), &jdks, &bundles);
        assert_eq!(cfg.args[0], "-data");
        assert!(cfg.args[1].starts_with("/data/lsp/jdtls/"), "{}", cfg.args[1]);
        assert_eq!(cfg.args[2], "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false");
        let opts = serde_json::to_value(cfg.initialization_options.clone().unwrap()).unwrap();
        let rt = &opts["settings"]["java"]["configuration"]["runtimes"];
        assert_eq!(rt[0], json!({ "name": "JavaSE-1.8", "path": "/jdk8" }));
        assert_eq!(rt[1], json!({ "name": "JavaSE-21", "path": "/jdk21a" }));
        assert_eq!(rt[2], json!({ "name": "JavaSE-25", "path": "/jdk25" }));
        assert_eq!(opts["bundles"], json!(["/tools/java-debug/bin/com.microsoft.java.debug.plugin.jar"]));

        // Deterministic (reconfigure compares configs) and idempotent.
        let before = cfg.clone();
        configure_jdtls(&mut cfg, Path::new("/p/demo"), Path::new("/data"), &jdks, &bundles);
        assert_eq!(cfg, before);

        let mut other: LanguageServerConfig = toml::from_str("name = \"pyright\"\ncommand = \"x\"").unwrap();
        configure_jdtls(&mut other, Path::new("/p"), Path::new("/data"), &jdks, &bundles);
        assert!(other.args.is_empty() && other.initialization_options.is_none());
    }

    #[test]
    fn picks_the_jdk_matching_the_project() {
        let jdks = [
            Jdk { major: 25, home: PathBuf::from("/jdk25") },
            Jdk { major: 21, home: PathBuf::from("/jdk21") },
            Jdk { major: 17, home: PathBuf::from("/jdk17") },
        ];
        assert_eq!(pick_jdk(&jdks, Some(21)).unwrap().major, 21);
        assert_eq!(pick_jdk(&jdks, Some(19)).unwrap().major, 21, "oldest newer one");
        assert_eq!(pick_jdk(&jdks, Some(26)).unwrap().major, 25, "newest as last resort");
        assert_eq!(pick_jdk(&jdks, None).unwrap().major, 25);
        assert!(pick_jdk(&[], Some(21)).is_none());
        assert_eq!(java_executable(Path::new("/jdk21")), Path::new("/jdk21/bin").join(crate::exe("java")));
    }

    #[test]
    fn project_java_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert_eq!(project_java_version(dir), None);
        std::fs::write(dir.join("pom.xml"), "<properties>\n<java.version>21</java.version>\n</properties>").unwrap();
        assert_eq!(project_java_version(dir), Some(21));
        std::fs::write(dir.join("pom.xml"), "<maven.compiler.source>1.8</maven.compiler.source>").unwrap();
        assert_eq!(project_java_version(dir), Some(8));
        std::fs::remove_file(dir.join("pom.xml")).unwrap();
        std::fs::write(
            dir.join("build.gradle.kts"),
            "java {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(17)\n  }\n}",
        )
        .unwrap();
        assert_eq!(project_java_version(dir), Some(17));
        std::fs::write(dir.join("build.gradle.kts"), "java { sourceCompatibility = JavaVersion.VERSION_11 }").unwrap();
        assert_eq!(project_java_version(dir), Some(11));
        std::fs::write(dir.join("build.gradle.kts"), "sourceCompatibility = '1.8'").unwrap();
        assert_eq!(project_java_version(dir), Some(8));
    }
}
