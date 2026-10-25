#![cfg(unix)]

use ide_core::{IdeEvent, RunId, SharedSink};
use ide_run::{OutputChunk, ProcessManager, RunConfig, StartOptions};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

struct Harness {
    pm: ProcessManager,
    sink: SharedSink,
    events: Receiver<IdeEvent>,
    root: tempfile::TempDir,
}

fn channel_sink() -> (SharedSink, Receiver<IdeEvent>) {
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: SharedSink = Arc::new(move |e: IdeEvent| {
        let _ = tx.lock().send(e);
    });
    (sink, events)
}

fn harness() -> Harness {
    let (sink, events) = channel_sink();
    Harness { pm: ProcessManager::new(), sink, events, root: tempfile::tempdir().unwrap() }
}

fn cfg(id: &str, command: &str, args: &[&str]) -> RunConfig {
    RunConfig {
        id: id.into(),
        name: id.into(),
        kind: "shell".into(),
        command: command.into(),
        args: args.iter().map(|s| (*s).to_owned()).collect(),
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
    }
}

type Chunks = Arc<Mutex<Vec<OutputChunk>>>;

fn start(h: &Harness, config: &RunConfig) -> (RunId, Chunks) {
    let chunks: Chunks = Arc::default();
    let sink = chunks.clone();
    let info = h
        .pm
        .start(h.root.path(), config, &StartOptions::default(), h.sink.clone(), Box::new(move |c| sink.lock().push(c)))
        .expect("start");
    assert!(info.running);
    assert_eq!(info.config_id, config.id);
    (info.id, chunks)
}

fn wait_exit(h: &Harness, id: RunId, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match h.events.recv_timeout(left).expect("RunExited event") {
            IdeEvent::RunExited { run, code } if run == id => return code,
            _ => {}
        }
    }
}

fn text(chunks: &Chunks, pick: fn(&OutputChunk) -> Option<&str>) -> String {
    chunks.lock().iter().filter_map(pick).collect()
}

fn stdout(c: &OutputChunk) -> Option<&str> {
    if let OutputChunk::Stdout { text } = c { Some(text) } else { None }
}
fn stderr(c: &OutputChunk) -> Option<&str> {
    if let OutputChunk::Stderr { text } = c { Some(text) } else { None }
}
fn system(c: &OutputChunk) -> Option<&str> {
    if let OutputChunk::System { text } = c { Some(text) } else { None }
}

fn wait_for(chunks: &Chunks, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = text(chunks, stdout);
        if out.contains(needle) {
            return out;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {needle:?}; got {out:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn output_streams_and_exit_code() {
    let h = harness();
    let config = cfg("t:out", "/bin/sh", &["-c", "printf 'out \\344\\270\\255'; printf 'err' >&2; exit 7"]);
    let (id, chunks) = start(&h, &config);
    assert_eq!(wait_exit(&h, id, Duration::from_secs(10)), Some(7));

    let all = chunks.lock().clone();
    match &all[0] {
        OutputChunk::System { text } => assert!(text.starts_with("/bin/sh -c 'printf"), "{text}"),
        other => panic!("first chunk must echo the command, got {other:?}"),
    }
    assert!(
        matches!(all.last(), Some(OutputChunk::System { text }) if text.contains("Process finished with exit code 7"))
    );
    assert_eq!(text(&chunks, stdout), "out 中");
    assert_eq!(text(&chunks, stderr), "err");

    let info = h.pm.list().into_iter().find(|r| r.id == id).unwrap();
    assert!(!info.running);
    assert!(h.pm.write_stdin(id, "x").is_err());
}

#[test]
fn shell_command_string_and_env_and_cwd() {
    let h = harness();
    std::fs::create_dir(h.root.path().join("sub")).unwrap();
    let mut config = cfg("t:shell", "echo \"$OPENIDEA_VAR\" && pwd | tr -d '\\n'", &[]);
    config.env.insert("OPENIDEA_VAR".into(), "hello".into());
    config.cwd = Some(PathBuf::from("sub").into());
    let (id, chunks) = start(&h, &config);
    assert_eq!(wait_exit(&h, id, Duration::from_secs(10)), Some(0));
    let out = text(&chunks, stdout);
    let mut lines = out.lines();
    assert_eq!(lines.next(), Some("hello"));
    let cwd = Path::new(lines.next().unwrap()).canonicalize().unwrap();
    assert_eq!(cwd, h.root.path().join("sub").canonicalize().unwrap());
    assert!(text(&chunks, system).starts_with("echo \"$OPENIDEA_VAR\""));
}

#[test]
fn stdin_echo_with_cat() {
    let h = harness();
    let (id, chunks) = start(&h, &cfg("t:cat", "cat", &[]));
    h.pm.write_stdin(id, "ping é\n").unwrap();
    wait_for(&chunks, "ping é\n");
    h.pm.write_stdin(id, "pong\n").unwrap();
    wait_for(&chunks, "pong\n");
    h.pm.close_stdin(id).unwrap();
    assert_eq!(wait_exit(&h, id, Duration::from_secs(10)), Some(0));
}

#[test]
fn missing_command_and_cwd_are_errors() {
    let h = harness();
    let err =
        h.pm.start(
            h.root.path(),
            &cfg("t:nope", "openidea-no-such-binary-xyz", &[]),
            &StartOptions::default(),
            h.sink.clone(),
            Box::new(|_| {}),
        )
        .unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
    let mut config = cfg("t:cwd", "true", &[]);
    config.cwd = Some("missing-dir".into());
    assert!(h.pm.start(h.root.path(), &config, &StartOptions::default(), h.sink.clone(), Box::new(|_| {})).is_err());
    assert!(
        h.pm.start(
            h.root.path(),
            &cfg("t:empty", "  ", &[]),
            &StartOptions::default(),
            h.sink.clone(),
            Box::new(|_| {})
        )
        .is_err()
    );
}

#[test]
fn stop_interrupts_process() {
    let h = harness();
    let (id, chunks) = start(&h, &cfg("t:sleep", "sleep", &["30"]));
    let started = Instant::now();
    h.pm.stop(id).unwrap();
    assert_eq!(wait_exit(&h, id, Duration::from_secs(10)), Some(130));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(text(&chunks, system).contains("Process finished with exit code 130 (interrupted by signal 2:SIGINT)"));
    // Stopping a finished run is a no-op.
    h.pm.stop(id).unwrap();
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn stop_kills_whole_process_group() {
    let h = harness();
    // Background jobs of a non-interactive shell ignore SIGINT, so this needs the SIGKILL escalation.
    let (id, chunks) = start(&h, &cfg("t:group", "/bin/sh", &["-c", "sleep 30 & echo $!; wait"]));
    let out = wait_for(&chunks, "\n");
    let grandchild: i32 = out.trim().parse().expect("pid");
    assert!(alive(grandchild));

    h.pm.stop(id).unwrap();
    wait_exit(&h, id, Duration::from_secs(10));
    let deadline = Instant::now() + Duration::from_secs(8);
    while alive(grandchild) {
        assert!(Instant::now() < deadline, "grandchild {grandchild} survived stop");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn list_prunes_finished_runs_of_same_config() {
    let h = harness();
    let config = cfg("t:list", "true", &[]);
    let (first, _) = start(&h, &config);
    wait_exit(&h, first, Duration::from_secs(10));
    assert!(h.pm.list().iter().any(|r| r.id == first && !r.running));

    let (second, _) = start(&h, &cfg("t:list", "sleep", &["5"]));
    let list = h.pm.list();
    assert!(list.iter().all(|r| r.id != first));
    assert!(list.iter().any(|r| r.id == second && r.running && r.pid.is_some()));
    h.pm.stop(second).unwrap();
    wait_exit(&h, second, Duration::from_secs(10));
}

#[test]
fn large_output_is_complete_and_batched() {
    let h = harness();
    let script = "i=0; while [ $i -lt 3000 ]; do printf '%05d-\\342\\224\\200\\n' $i; i=$((i+1)); done";
    let (id, chunks) = start(&h, &cfg("t:big", "/bin/sh", &["-c", script]));
    assert_eq!(wait_exit(&h, id, Duration::from_secs(20)), Some(0));
    let out = text(&chunks, stdout);
    assert_eq!(out.lines().count(), 3000);
    assert!(!out.contains('\u{FFFD}'));
    assert!(chunks.lock().len() < 3000);
}

#[test]
fn relative_program_resolves_against_cwd() {
    let h = harness();
    let script = h.root.path().join("tool.sh");
    std::fs::write(&script, "#!/bin/sh\necho tool-ran\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (id, chunks) = start(&h, &cfg("t:rel", "./tool.sh", &[]));
    assert_eq!(wait_exit(&h, id, Duration::from_secs(10)), Some(0));
    assert_eq!(text(&chunks, stdout), "tool-ran\n");
}

#[test]
fn exit_event_goes_to_the_starters_sink_only() {
    let h = harness();
    let (other_sink, other_events) = channel_sink();
    let (mine, _) = start(&h, &cfg("t:mine", "true", &[]));
    let info =
        h.pm.start(h.root.path(), &cfg("t:other", "true", &[]), &StartOptions::default(), other_sink, Box::new(|_| {}))
            .unwrap();
    match h.events.recv_timeout(Duration::from_secs(10)).expect("RunExited for the starter") {
        IdeEvent::RunExited { run, code } => assert_eq!((run, code), (mine, Some(0))),
        e => panic!("unexpected {e:?}"),
    }
    match other_events.recv_timeout(Duration::from_secs(10)).expect("RunExited for the other sink") {
        IdeEvent::RunExited { run, code } => assert_eq!((run, code), (info.id, Some(0))),
        e => panic!("unexpected {e:?}"),
    }
    // Neither sink sees the other's run.
    std::thread::sleep(Duration::from_millis(100));
    assert!(other_events.try_recv().is_err());
    assert!(h.events.try_recv().is_err());
}
