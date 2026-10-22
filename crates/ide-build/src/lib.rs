//! Build tool models for the Maven and Gradle tool windows, and Build › Build
//! Project ([`compile`]) for Maven, Gradle, Cargo, Go and TypeScript projects.
//!
//! [`load`] reads the project's build files (instant, no build tool involved)
//! and merges what the last sync ([`sync_maven`] / [`sync_gradle`], which run
//! Maven / Gradle in the background) cached for the project.

pub mod compile;
pub mod gradle;
pub mod maven;
mod process;
mod sync;
mod xml;

pub use gradle::{GradleModel, GradleProject, GradleTask};
pub use maven::{MavenDependency, MavenModel, MavenPlugin, MavenProfile, MavenProject};
pub use sync::{SyncOptions, SyncProgress, sync_gradle, sync_maven};

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BuildTool {
    Maven,
    Gradle,
}

/// The build systems of a project; `None` when the project does not use one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildModel {
    pub maven: Option<MavenModel>,
    pub gradle: Option<GradleModel>,
}

/// Static model of the builds under `root`, merged with the sync results cached in `cache_dir`.
pub fn load(root: &Path, cache_dir: &Path) -> BuildModel {
    let maven = maven::is_maven_project(root).then(|| {
        let mut m = maven::load(root);
        sync::apply_maven_cache(root, cache_dir, &mut m);
        m
    });
    let gradle = gradle::load(root).map(|mut g| {
        sync::apply_gradle_cache(root, cache_dir, &mut g);
        g
    });
    BuildModel { maven, gradle }
}

/// Whether a created / changed / removed project-relative path can change the build model.
pub fn affects_build(rel: &Path) -> bool {
    let Some(name) = rel.file_name().and_then(|n| n.to_str()) else { return false };
    name == "pom.xml"
        || gradle::SETTINGS_FILES.contains(&name)
        || gradle::BUILD_FILES.contains(&name)
        || matches!(name, "mvnw" | "mvnw.cmd" | "gradlew" | "gradlew.bat")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_build_systems_and_build_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("svc")).unwrap();
        assert_eq!(load(&root, &cache), BuildModel::default());
        std::fs::write(root.join("svc/pom.xml"), "<project><artifactId>svc</artifactId></project>").unwrap();
        std::fs::write(root.join("build.gradle"), "").unwrap();
        let m = load(&root, &cache);
        assert_eq!(m.maven.unwrap().projects[0].pom, "svc/pom.xml");
        assert_eq!(m.gradle.unwrap().projects[0].path, ":");
        assert!(affects_build(Path::new("a/pom.xml")) && affects_build(Path::new("settings.gradle.kts")));
        assert!(!affects_build(Path::new("src/Main.java")));
    }
}
