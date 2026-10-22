<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src-tauri/icons/source/openidea-wordmark-dark.svg">
    <img src="src-tauri/icons/source/openidea-wordmark.svg" alt="OpenIDEA" height="64">
  </picture>
</h1>

An open-source desktop IDE in the spirit of IntelliJ IDEA, built with Rust and Tauri.

<sub>Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.</sub>

> [!WARNING]
> OpenIDEA is early-stage software (0.1). Expect rough edges and breaking changes.

## Features

- **Editor** — CodeMirror 6 with tree-sitter highlighting, folding, multi-caret,
  live templates and an IDEA-style keymap.
- **Code insight** — LSP-backed completion, navigation, find usages, rename and
  refactorings, diagnostics and inspections, plus a fast project-wide index.
- **Search** — Search Everywhere, Go to File / Symbol / Action, Find in Files.
- **Run & debug** — run configurations, DAP debugging, test runner, coverage and
  a profiler.
- **Build tools** — Maven and Gradle project sync and builds.
- **Version control** — Git (status, diff, commit, history, branches, blame) and
  GitHub pull requests.
- **Tools** — integrated terminal, database client (PostgreSQL, MySQL, SQLite,
  SSH tunnels), HTTP client, Docker, scratch files and TODO view.
- **Languages** — 60+ languages via declarative definitions in
  [`languages/`](languages): detection, comments, language server and debug
  adapter in one TOML file each.
- **Plugins** — sandboxed WebAssembly plugins against the [`wit/plugin.wit`](wit)
  interface; see [`plugins/`](plugins) for examples.

## Building from source

Requirements: Rust 1.96+, Node.js 22+, pnpm, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
pnpm install
pnpm tauri dev      # run the app in development mode
pnpm tauri build    # produce a release bundle
```

Language servers and debug adapters are not bundled; OpenIDEA finds them on
`PATH` or offers to download them on first use.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test       # frontend
cargo nextest run --workspace                  # backend tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
pnpm gen:bindings                              # regenerate src/bindings.ts after IPC changes
pnpm perf && pnpm perf:rust                    # performance checks vs perf/budgets.json
```

Project layout:

| Path | Contents |
| --- | --- |
| `crates/ide-*` | Backend crates, one domain each (VFS, index, LSP, DAP, VCS, run, …) |
| `src-tauri/` | Tauri app: state and thin IPC command adapters |
| `src/` | React UI: `platform/` (IPC, actions, keymaps), `workbench/`, `ui/` (design system), `features/` |
| `languages/` | Language definitions |
| `plugins/`, `wit/` | Example plugins and the plugin interface |

## License

[Apache License 2.0](LICENSE); see [`NOTICE`](NOTICE). Bundled third-party assets,
including icons from the IntelliJ Platform, are listed in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
