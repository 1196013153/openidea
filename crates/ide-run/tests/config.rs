use ide_run::{RunConfig, load_user_configs, save_user_configs, user_configs_path};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn sample() -> Vec<RunConfig> {
    vec![
        RunConfig {
            id: "user:server".into(),
            name: "Server \"prod\"".into(),
            kind: "shell".into(),
            command: "cargo".into(),
            args: vec!["run".into(), "--release".into()],
            cwd: Some(PathBuf::from("server").into()),
            env: BTreeMap::from([("RUST_LOG".into(), "debug".into()), ("A B".into(), "x=y".into())]),
            detected: false,
            is_test: false,
            debug_adapter: Some("codelldb".into()),
            allow_parallel: true,
        },
        RunConfig {
            id: "user:tests".into(),
            name: "Tests".into(),
            kind: "pytest".into(),
            command: "pytest -q tests/".into(),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            detected: false,
            is_test: true,
            debug_adapter: None,
            allow_parallel: false,
        },
    ]
}

#[test]
fn missing_file_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load_user_configs(dir.path()).unwrap().is_empty());
    // Saving nothing does not create the file.
    save_user_configs(dir.path(), &[]).unwrap();
    assert!(!user_configs_path(dir.path()).exists());
}

#[test]
fn round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let configs = sample();
    save_user_configs(dir.path(), &configs).unwrap();
    assert!(dir.path().join(".openidea/run.toml").is_file());
    assert_eq!(load_user_configs(dir.path()).unwrap(), configs);

    // Saving a detected config persists it as a user config.
    let mut detected = configs[0].clone();
    detected.detected = true;
    save_user_configs(dir.path(), &[detected]).unwrap();
    let loaded = load_user_configs(dir.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert!(!loaded[0].detected);
}

#[test]
fn preserves_unrelated_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = user_configs_path(dir.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        "# OpenIDEA run configurations\ndefault = \"user:server\"\n\n[[configurations]]\nid = \"old\"\ncommand = \"x\"\n\n[ui]\nshow-output = true\n",
    )
    .unwrap();
    save_user_configs(dir.path(), &sample()).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("# OpenIDEA run configurations"), "{text}");
    assert!(text.contains("default = \"user:server\""), "{text}");
    assert!(text.contains("show-output = true"), "{text}");
    assert!(!text.contains("\"old\""), "{text}");
    assert_eq!(load_user_configs(dir.path()).unwrap(), sample());

    save_user_configs(dir.path(), &[]).unwrap();
    assert!(load_user_configs(dir.path()).unwrap().is_empty());
    assert!(fs::read_to_string(&path).unwrap().contains("show-output"));
}

#[test]
fn lenient_hand_written_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = user_configs_path(dir.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        "[[configurations]]\nname = \"Dev Server\"\ncommand = \"npm run dev\"\nisTest = false\n\n[[configurations]]\ncommand = \"make test\"\nis_test = true\ndebugAdapter = \"lldb\"\n",
    )
    .unwrap();
    let c = load_user_configs(dir.path()).unwrap();
    assert_eq!(c.len(), 2);
    assert_eq!(c[0].id, "user:dev-server");
    assert_eq!(c[0].kind, "shell");
    assert_eq!(c[1].name, "make test");
    assert!(c[1].is_test);
    assert_eq!(c[1].debug_adapter.as_deref(), Some("lldb"));
}

#[test]
fn invalid_file_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let path = user_configs_path(dir.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "[[configurations]\n").unwrap();
    let err = load_user_configs(dir.path()).unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::InvalidInput);
    assert!(err.message.contains("run.toml"));
}
