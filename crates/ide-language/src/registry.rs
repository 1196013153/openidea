use crate::LanguageConfig;
use ide_core::{IdeError, IdeResult, LanguageId};
use std::collections::HashMap;
use std::path::Path;

/// Built-in definitions, embedded at compile time. Add new languages here.
const BUILTIN: &[(&str, &str)] = &[
    ("c", include_str!("../../../languages/c.toml")),
    ("clojure", include_str!("../../../languages/clojure.toml")),
    ("cmake", include_str!("../../../languages/cmake.toml")),
    ("cpp", include_str!("../../../languages/cpp.toml")),
    ("csharp", include_str!("../../../languages/csharp.toml")),
    ("css", include_str!("../../../languages/css.toml")),
    ("dart", include_str!("../../../languages/dart.toml")),
    ("diff", include_str!("../../../languages/diff.toml")),
    ("dockerfile", include_str!("../../../languages/dockerfile.toml")),
    ("dotenv", include_str!("../../../languages/dotenv.toml")),
    ("elixir", include_str!("../../../languages/elixir.toml")),
    ("erlang", include_str!("../../../languages/erlang.toml")),
    ("fsharp", include_str!("../../../languages/fsharp.toml")),
    ("gitattributes", include_str!("../../../languages/gitattributes.toml")),
    ("go", include_str!("../../../languages/go.toml")),
    ("gomod", include_str!("../../../languages/gomod.toml")),
    ("gowork", include_str!("../../../languages/gowork.toml")),
    ("graphql", include_str!("../../../languages/graphql.toml")),
    ("groovy", include_str!("../../../languages/groovy.toml")),
    ("haskell", include_str!("../../../languages/haskell.toml")),
    ("hcl", include_str!("../../../languages/hcl.toml")),
    ("html", include_str!("../../../languages/html.toml")),
    ("http", include_str!("../../../languages/http.toml")),
    ("ignore", include_str!("../../../languages/ignore.toml")),
    ("ini", include_str!("../../../languages/ini.toml")),
    ("java", include_str!("../../../languages/java.toml")),
    ("javascript", include_str!("../../../languages/javascript.toml")),
    ("javascriptreact", include_str!("../../../languages/javascriptreact.toml")),
    ("json", include_str!("../../../languages/json.toml")),
    ("jsonc", include_str!("../../../languages/jsonc.toml")),
    ("julia", include_str!("../../../languages/julia.toml")),
    ("kotlin", include_str!("../../../languages/kotlin.toml")),
    ("latex", include_str!("../../../languages/latex.toml")),
    ("less", include_str!("../../../languages/less.toml")),
    ("log", include_str!("../../../languages/log.toml")),
    ("lua", include_str!("../../../languages/lua.toml")),
    ("makefile", include_str!("../../../languages/makefile.toml")),
    ("markdown", include_str!("../../../languages/markdown.toml")),
    ("nix", include_str!("../../../languages/nix.toml")),
    ("objective-c", include_str!("../../../languages/objective-c.toml")),
    ("objective-cpp", include_str!("../../../languages/objective-cpp.toml")),
    ("ocaml", include_str!("../../../languages/ocaml.toml")),
    ("ocaml-interface", include_str!("../../../languages/ocaml-interface.toml")),
    ("perl", include_str!("../../../languages/perl.toml")),
    ("php", include_str!("../../../languages/php.toml")),
    ("plaintext", include_str!("../../../languages/plaintext.toml")),
    ("powershell", include_str!("../../../languages/powershell.toml")),
    ("properties", include_str!("../../../languages/properties.toml")),
    ("proto", include_str!("../../../languages/proto.toml")),
    ("python", include_str!("../../../languages/python.toml")),
    ("r", include_str!("../../../languages/r.toml")),
    ("ruby", include_str!("../../../languages/ruby.toml")),
    ("rust", include_str!("../../../languages/rust.toml")),
    ("sass", include_str!("../../../languages/sass.toml")),
    ("scala", include_str!("../../../languages/scala.toml")),
    ("scss", include_str!("../../../languages/scss.toml")),
    ("shellscript", include_str!("../../../languages/shellscript.toml")),
    ("sql", include_str!("../../../languages/sql.toml")),
    ("svelte", include_str!("../../../languages/svelte.toml")),
    ("swift", include_str!("../../../languages/swift.toml")),
    ("terraform", include_str!("../../../languages/terraform.toml")),
    ("terraform-vars", include_str!("../../../languages/terraform-vars.toml")),
    ("toml", include_str!("../../../languages/toml.toml")),
    ("typescript", include_str!("../../../languages/typescript.toml")),
    ("typescriptreact", include_str!("../../../languages/typescriptreact.toml")),
    ("vue", include_str!("../../../languages/vue.toml")),
    ("xml", include_str!("../../../languages/xml.toml")),
    ("yaml", include_str!("../../../languages/yaml.toml")),
    ("zig", include_str!("../../../languages/zig.toml")),
];

pub struct LanguageRegistry {
    languages: Vec<LanguageConfig>,
    by_ext: HashMap<String, usize>,
    by_name: HashMap<String, usize>,
    /// File-name patterns containing `*`, e.g. `Dockerfile.*`, `tsconfig.*.json`.
    name_globs: Vec<(String, usize)>,
    first_line: Vec<(regex_lite::Regex, usize)>,
}

impl LanguageRegistry {
    /// Loads the built-in definitions plus `*.toml` overrides from `user_dir`
    /// (a user file with the same `id` replaces the built-in one).
    pub fn load(user_dir: Option<&Path>) -> IdeResult<Self> {
        let mut configs = Vec::new();
        for (name, src) in BUILTIN {
            configs.push(parse(src).map_err(|e| IdeError::internal(format!("languages/{name}.toml: {e}")))?);
        }
        if let Some(dir) = user_dir.filter(|d| d.is_dir()) {
            for entry in std::fs::read_dir(dir)?.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "toml") {
                    match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| parse(&s)) {
                        Ok(cfg) => configs.push(cfg),
                        Err(e) => tracing::warn!("ignoring {}: {e}", path.display()),
                    }
                }
            }
        }
        Ok(Self::from_configs(configs))
    }

    /// Builds a registry from explicit configs; later entries override earlier ones by id.
    pub fn from_configs(configs: Vec<LanguageConfig>) -> Self {
        let mut languages: Vec<LanguageConfig> = Vec::new();
        for cfg in configs {
            match languages.iter_mut().find(|l| l.id == cfg.id) {
                Some(existing) => *existing = cfg,
                None => languages.push(cfg),
            }
        }
        let mut by_ext = HashMap::new();
        let mut by_name = HashMap::new();
        let mut name_globs = Vec::new();
        let mut first_line = Vec::new();
        for (i, l) in languages.iter().enumerate() {
            for ext in &l.extensions {
                by_ext.insert(ext.to_ascii_lowercase(), i);
            }
            for name in &l.filenames {
                if name.contains('*') {
                    name_globs.push((name.clone(), i));
                } else {
                    by_name.insert(name.clone(), i);
                }
            }
            if let Some(pattern) = l.first_line.as_deref() {
                match regex_lite::Regex::new(pattern) {
                    Ok(re) => first_line.push((re, i)),
                    Err(e) => tracing::warn!("language {}: invalid first-line pattern: {e}", l.id),
                }
            }
        }
        // More specific (longer) patterns first: `tsconfig.*.json` before `*.json`-like ones.
        name_globs.sort_by_key(|(p, _): &(String, usize)| std::cmp::Reverse(p.len()));
        Self { languages, by_ext, by_name, name_globs, first_line }
    }

    pub fn all(&self) -> Vec<LanguageConfig> {
        self.languages.clone()
    }

    pub fn get(&self, id: &LanguageId) -> Option<LanguageConfig> {
        self.languages.iter().find(|l| &l.id == id).cloned()
    }

    /// Detects by exact file name, then file-name pattern (`Dockerfile.*`), then
    /// extension (longest compound first, e.g. `d.ts`), then first line; falls
    /// back to plaintext.
    pub fn detect(&self, path: &Path, first_line: Option<&str>) -> LanguageId {
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if let Some(&i) = self.by_name.get(file_name) {
            return self.languages[i].id.clone();
        }
        if let Some((_, i)) = self.name_globs.iter().find(|(p, _)| wildcard_match(p, file_name)) {
            return self.languages[*i].id.clone();
        }
        let lower = file_name.to_ascii_lowercase();
        let mut rest = lower.as_str();
        while let Some(dot) = rest.find('.') {
            rest = &rest[dot + 1..];
            if let Some(&i) = self.by_ext.get(rest) {
                return self.languages[i].id.clone();
            }
        }
        if let Some(line) = first_line
            && let Some((_, i)) = self.first_line.iter().find(|(re, _)| re.is_match(line))
        {
            return self.languages[*i].id.clone();
        }
        LanguageId::plain_text()
    }
}

/// `*` matches any (possibly empty) run of characters; everything else is literal.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = name.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for part in middle {
        match rest.find(part) {
            Some(i) => rest = &rest[i + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

fn parse(src: &str) -> Result<LanguageConfig, String> {
    toml::from_str(src).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// `name`s exported by `@codemirror/language-data` (the UI resolves `ui-mode` against these).
    const UI_MODES: &[&str] = &[
        "C",
        "C++",
        "CQL",
        "CSS",
        "Go",
        "HTML",
        "Java",
        "JavaScript",
        "Jinja",
        "JSON",
        "JSX",
        "LESS",
        "Liquid",
        "MariaDB SQL",
        "Markdown",
        "MS SQL",
        "MySQL",
        "PHP",
        "PLSQL",
        "PostgreSQL",
        "Python",
        "Rust",
        "Sass",
        "SCSS",
        "SQL",
        "SQLite",
        "TSX",
        "TypeScript",
        "WebAssembly",
        "XML",
        "YAML",
        "APL",
        "PGP",
        "ASN.1",
        "Asterisk",
        "Brainfuck",
        "Cobol",
        "C#",
        "Clojure",
        "ClojureScript",
        "Closure Stylesheets (GSS)",
        "CMake",
        "CoffeeScript",
        "Common Lisp",
        "Cypher",
        "Cython",
        "Crystal",
        "D",
        "Dart",
        "diff",
        "Dockerfile",
        "DTD",
        "Dylan",
        "EBNF",
        "ECL",
        "edn",
        "Eiffel",
        "Elm",
        "Erlang",
        "Esper",
        "Factor",
        "FCL",
        "Forth",
        "Fortran",
        "F#",
        "Gas",
        "Gherkin",
        "Groovy",
        "Haskell",
        "Haxe",
        "HXML",
        "HTTP",
        "IDL",
        "JSON-LD",
        "Julia",
        "Kotlin",
        "LiveScript",
        "Lua",
        "mIRC",
        "Mathematica",
        "Modelica",
        "MUMPS",
        "Mbox",
        "Nginx",
        "NSIS",
        "NTriples",
        "Objective-C",
        "Objective-C++",
        "OCaml",
        "Octave",
        "Oz",
        "Pascal",
        "Perl",
        "Pig",
        "PowerShell",
        "Properties files",
        "ProtoBuf",
        "Pug",
        "Puppet",
        "Q",
        "R",
        "RPM Changes",
        "RPM Spec",
        "Ruby",
        "SAS",
        "Scala",
        "Scheme",
        "Shell",
        "Sieve",
        "Smalltalk",
        "Solr",
        "SML",
        "SPARQL",
        "Spreadsheet",
        "Squirrel",
        "Stylus",
        "Swift",
        "sTeX",
        "LaTeX",
        "SystemVerilog",
        "Tcl",
        "Textile",
        "TiddlyWiki",
        "Tiki wiki",
        "TOML",
        "Troff",
        "TTCN",
        "TTCN_CFG",
        "Turtle",
        "Web IDL",
        "VB.NET",
        "VBScript",
        "Velocity",
        "Verilog",
        "VHDL",
        "XQuery",
        "Yacas",
        "Z80",
        "MscGen",
        "Xù",
        "MsGenny",
        "Vue",
        "Angular Template",
    ];

    fn reg() -> LanguageRegistry {
        LanguageRegistry::load(None).unwrap()
    }

    fn detect(reg: &LanguageRegistry, path: &str) -> String {
        reg.detect(Path::new(path), None).0
    }

    #[test]
    fn builtins_parse_and_detect() {
        let reg = reg();
        assert_eq!(detect(&reg, "src/main.rs"), "rust");
        assert_eq!(detect(&reg, "a/b.TS"), "typescript");
        assert_eq!(reg.detect(Path::new("script"), Some("#!/usr/bin/env python3")).as_str(), "python");
        assert_eq!(detect(&reg, "README"), "plaintext");
        assert_eq!(detect(&reg, "unknown.zzz"), "plaintext");
        let rust = reg.get(&LanguageId::new("rust")).unwrap();
        assert_eq!(rust.language_servers[0].name, "rust-analyzer");
    }

    #[test]
    fn alternative_servers_are_fallbacks() {
        let reg = reg();
        for (lang, servers) in
            [("python", ["basedpyright", "pyright"]), ("typescript", ["vtsls", "typescript-language-server"])]
        {
            let cfg = reg.get(&LanguageId::new(lang)).unwrap();
            let got: Vec<(&str, bool)> = cfg.language_servers.iter().map(|s| (s.name.as_str(), s.fallback)).collect();
            assert_eq!(got, [(servers[0], false), (servers[1], true)]);
        }
    }

    #[test]
    fn every_builtin_file_is_registered_and_parses() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../languages");
        let on_disk: HashSet<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".toml").map(str::to_owned))
            .collect();
        let registered: HashSet<String> = BUILTIN.iter().map(|(n, _)| (*n).to_owned()).collect();
        assert_eq!(on_disk, registered, "languages/*.toml and BUILTIN differ");
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap_or_else(|e| panic!("languages/{name}.toml: {e}"));
            assert!(!cfg.name.is_empty(), "{name}: empty name");
            if let Some(re) = &cfg.first_line {
                regex_lite::Regex::new(re).unwrap_or_else(|e| panic!("{name}: bad first-line: {e}"));
            }
            for ls in &cfg.language_servers {
                assert!(!ls.command.is_empty() && ls.install_hint.is_some(), "{name}: {} incomplete", ls.name);
            }
            if let Some(d) = &cfg.debugger {
                assert!(matches!(d.transport.as_str(), "stdio" | "tcp"), "{name}: bad transport");
                assert!(d.install_hint.is_some(), "{name}: debugger without install hint");
            }
            for ext in &cfg.extensions {
                assert_eq!(ext, &ext.to_ascii_lowercase(), "{name}: extensions must be lower case");
                assert!(!ext.starts_with('.'), "{name}: extension {ext} must not start with a dot");
            }
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = HashSet::new();
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            assert!(seen.insert(cfg.id.0.clone()), "duplicate id {} ({name})", cfg.id);
        }
    }

    #[test]
    fn extensions_and_filenames_do_not_collide() {
        let mut exts: HashMap<String, String> = HashMap::new();
        let mut names: HashMap<String, String> = HashMap::new();
        for (_, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            for ext in &cfg.extensions {
                if let Some(other) = exts.insert(ext.clone(), cfg.id.0.clone()) {
                    panic!("extension .{ext} claimed by {other} and {}", cfg.id);
                }
            }
            for n in &cfg.filenames {
                if let Some(other) = names.insert(n.clone(), cfg.id.0.clone()) {
                    panic!("file name {n} claimed by {other} and {}", cfg.id);
                }
            }
        }
    }

    #[test]
    fn ui_modes_exist_in_codemirror_language_data() {
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            if let Some(mode) = &cfg.ui_mode {
                assert!(UI_MODES.contains(&mode.as_str()), "{name}: ui-mode {mode:?} is not a language-data name");
            }
        }
    }

    #[test]
    fn tree_sitter_names_are_bundled() {
        let grammars: HashSet<&str> = crate::Syntax::grammar_names().collect();
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            if let Some(ts) = &cfg.tree_sitter {
                assert!(grammars.contains(ts.as_str()), "{name}: tree-sitter grammar {ts:?} is not bundled");
            }
        }
    }

    #[test]
    fn detects_the_catalogue() {
        let reg = reg();
        let cases = [
            ("lib.rs", "rust"),
            ("index.d.ts", "typescript"),
            ("App.tsx", "typescriptreact"),
            ("a.mjs", "javascript"),
            ("Button.jsx", "javascriptreact"),
            ("stub.pyi", "python"),
            ("main.go", "go"),
            ("go.mod", "go.mod"),
            ("Main.java", "java"),
            ("Main.kt", "kotlin"),
            ("build.gradle.kts", "kotlin"),
            ("build.gradle", "groovy"),
            ("Jenkinsfile", "groovy"),
            ("App.scala", "scala"),
            ("build.sbt", "scala"),
            ("x.c", "c"),
            ("x.h", "c"),
            ("x.hpp", "cpp"),
            ("x.cc", "cpp"),
            ("P.cs", "csharp"),
            ("V.swift", "swift"),
            ("AppDelegate.m", "objective-c"),
            ("a.rb", "ruby"),
            ("Gemfile", "ruby"),
            ("index.php", "php"),
            ("init.lua", "lua"),
            ("main.dart", "dart"),
            ("build.zig", "zig"),
            ("mix.exs", "elixir"),
            ("Main.hs", "haskell"),
            ("a.ml", "ocaml"),
            ("a.mli", "ocaml.interface"),
            ("analysis.R", "r"),
            ("a.jl", "julia"),
            ("deploy.sh", "shellscript"),
            (".zshrc", "shellscript"),
            ("Build.ps1", "powershell"),
            ("schema.sql", "sql"),
            ("api.http", "http"),
            ("api.rest", "http"),
            ("index.html", "html"),
            ("a.css", "css"),
            ("a.scss", "scss"),
            ("a.less", "less"),
            ("App.vue", "vue"),
            ("App.svelte", "svelte"),
            ("package.json", "json"),
            ("tsconfig.json", "jsonc"),
            ("tsconfig.app.json", "jsonc"),
            ("ci.yml", "yaml"),
            ("Cargo.toml", "toml"),
            ("Cargo.lock", "toml"),
            ("pom.xml", "xml"),
            ("README.md", "markdown"),
            ("Dockerfile", "dockerfile"),
            ("Dockerfile.dev", "dockerfile"),
            ("Makefile", "makefile"),
            ("rules.mk", "makefile"),
            ("CMakeLists.txt", "cmake"),
            ("api.proto", "proto"),
            ("schema.graphql", "graphql"),
            ("main.tf", "terraform"),
            ("prod.tfvars", "terraform-vars"),
            ("job.nomad", "hcl"),
            ("flake.nix", "nix"),
            ("setup.cfg", "ini"),
            ("app.properties", "properties"),
            (".env", "dotenv"),
            (".env.local", "dotenv"),
            (".gitignore", "ignore"),
            (".gitattributes", "gitattributes"),
            ("server.log", "log"),
            ("notes.txt", "plaintext"),
        ];
        for (path, id) in cases {
            assert_eq!(detect(&reg, path), id, "{path}");
        }
    }

    #[test]
    fn detects_shebangs() {
        let reg = reg();
        let cases = [
            ("#!/bin/bash", "shellscript"),
            ("#!/usr/bin/env zsh", "shellscript"),
            ("#!/bin/sh -e", "shellscript"),
            ("#!/usr/bin/env node", "javascript"),
            ("#!/usr/bin/env ruby", "ruby"),
            ("#!/usr/bin/perl -w", "perl"),
            ("<?php", "php"),
            ("<?xml version=\"1.0\"?>", "xml"),
            ("<!DOCTYPE html>", "html"),
        ];
        for (line, id) in cases {
            assert_eq!(reg.detect(Path::new("noext"), Some(line)).as_str(), id, "{line}");
        }
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard_match("Dockerfile.*", "Dockerfile.dev"));
        assert!(!wildcard_match("Dockerfile.*", "Dockerfile"));
        assert!(wildcard_match("tsconfig.*.json", "tsconfig.base.json"));
        assert!(!wildcard_match("tsconfig.*.json", "tsconfig.json"));
        assert!(wildcard_match("*.Dockerfile", "web.Dockerfile"));
        assert!(wildcard_match("a*b*c", "aXbYc"));
        assert!(!wildcard_match("a*b*c", "aXcYb"));
    }

    #[test]
    fn user_overrides_replace_builtins() {
        let dir = std::env::temp_dir().join(format!("openidea-lang-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rust.toml"), "id = \"rust\"\nname = \"My Rust\"\nextensions = [\"rs\", \"rsx\"]\n")
            .unwrap();
        std::fs::write(dir.join("broken.toml"), "id = ").unwrap();
        let reg = LanguageRegistry::load(Some(&dir)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(reg.get(&LanguageId::new("rust")).unwrap().name, "My Rust");
        assert_eq!(detect(&reg, "x.rsx"), "rust");
        assert_eq!(reg.all().iter().filter(|l| l.id.as_str() == "rust").count(), 1);
    }
}
