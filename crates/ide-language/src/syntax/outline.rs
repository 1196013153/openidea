//! Outline / symbol extraction driven by `queries/<lang>/outline.scm`.
//!
//! Capture vocabulary:
//! - `@def.<kind>`: a definition; shown in the outline and emitted as a [`SymbolTag`].
//! - `@outline.<kind>`: shown in the outline only (JSON keys, Markdown headings, ...).
//! - `@name`: the identifier (several `@name` captures are joined with `.`).
//! - `@detail`: short extra text (signature, value).
//! - `@trait`: Rust `impl Trait for Type`.
//! - `@container`: explicit container for tags (Go method receivers).
//!
//! Kinds: class interface struct enum enum_member trait function method
//! constructor field property variable constant module namespace package type
//! macro event operator key heading impl extension.

use super::Grammar;
use super::lines::LineIndex;
use crate::SymbolTag;
use ide_core::{OutlineItem, SymbolKind};
use std::collections::HashMap;
use tree_sitter::{Node, Query, QueryCursor, StreamingIterator, Tree};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemKind {
    Symbol(SymbolKind),
    /// Rust `impl` block: named `impl [Trait for] Type`, contains methods of `Type`.
    Impl,
    /// Swift/Kotlin/Dart `extension`: contains members of the extended type.
    Extension,
    Heading,
}

impl ItemKind {
    fn parse(s: &str) -> Option<Self> {
        use SymbolKind as K;
        Some(Self::Symbol(match s {
            "class" => K::Class,
            "interface" => K::Interface,
            "struct" => K::Struct,
            "enum" => K::Enum,
            "enum_member" => K::EnumMember,
            "trait" => K::Trait,
            "function" => K::Function,
            "method" => K::Method,
            "constructor" => K::Constructor,
            "field" => K::Field,
            "property" => K::Property,
            "variable" => K::Variable,
            "constant" => K::Constant,
            "module" => K::Module,
            "namespace" => K::Namespace,
            "package" => K::Package,
            "type" => K::TypeAlias,
            "macro" => K::Macro,
            "event" => K::Event,
            "operator" => K::Operator,
            "key" => K::Key,
            "impl" => return Some(Self::Impl),
            "extension" => return Some(Self::Extension),
            "heading" => return Some(Self::Heading),
            _ => return None,
        }))
    }

    fn symbol_kind(self) -> SymbolKind {
        match self {
            Self::Symbol(k) => k,
            Self::Impl | Self::Extension => SymbolKind::Namespace,
            Self::Heading => SymbolKind::Key,
        }
    }

    /// Whether functions declared directly inside are methods.
    fn holds_methods(self) -> bool {
        match self {
            Self::Impl | Self::Extension => true,
            Self::Symbol(k) => matches!(
                k,
                SymbolKind::Class | SymbolKind::Interface | SymbolKind::Struct | SymbolKind::Enum | SymbolKind::Trait
            ),
            Self::Heading => false,
        }
    }
}

#[derive(Clone, Copy)]
enum Role {
    Def { kind: ItemKind, tag: bool },
    Name,
    Detail,
    Trait,
    Container,
    Ignore,
}

pub(crate) struct OutlineQuery {
    query: Query,
    roles: Vec<Role>,
    /// Whether any pattern yields symbol tags (`@def.*`).
    pub(crate) has_tags: bool,
}

impl OutlineQuery {
    pub(crate) fn new(language: &tree_sitter::Language, source: &str) -> Result<Self, String> {
        let query = Query::new(language, source).map_err(|e| e.to_string())?;
        let mut roles = Vec::new();
        for name in query.capture_names() {
            let role = if let Some(k) = name.strip_prefix("def.") {
                Role::Def { kind: ItemKind::parse(k).ok_or_else(|| format!("unknown kind @{name}"))?, tag: true }
            } else if let Some(k) = name.strip_prefix("outline.") {
                Role::Def { kind: ItemKind::parse(k).ok_or_else(|| format!("unknown kind @{name}"))?, tag: false }
            } else {
                match *name {
                    "name" => Role::Name,
                    "detail" => Role::Detail,
                    "trait" => Role::Trait,
                    "container" => Role::Container,
                    _ if name.starts_with('_') => Role::Ignore,
                    other => return Err(format!("unknown capture @{other}")),
                }
            };
            roles.push(role);
        }
        let has_tags = roles.iter().any(|r| matches!(r, Role::Def { tag: true, .. }));
        Ok(Self { query, roles, has_tags })
    }
}

struct Raw {
    node_id: usize,
    pattern: usize,
    start: usize,
    end: usize,
    range: ide_core::Range,
    sel: ide_core::Range,
    kind: ItemKind,
    tag: bool,
    name: String,
    /// Name used as `container` for nested symbols.
    container_name: String,
    explicit_container: Option<String>,
    detail: Option<String>,
}

struct Built {
    raw: Raw,
    kind: SymbolKind,
    children: Vec<Built>,
}

fn collect(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<Built> {
    let idx = LineIndex::new(text);
    let src = text.as_bytes();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&q.query, tree.root_node(), src);
    let mut by_node: HashMap<usize, Raw> = HashMap::new();
    while let Some(m) = matches.next() {
        let mut def: Option<(Node, ItemKind, bool)> = None;
        let mut names: Vec<Node> = Vec::new();
        let (mut detail, mut trait_, mut container) = (None, None, None);
        for c in m.captures {
            match q.roles[c.index as usize] {
                Role::Def { kind, tag } => def = Some((c.node, kind, tag)),
                Role::Name => names.push(c.node),
                Role::Detail => detail = Some(c.node),
                Role::Trait => trait_ = Some(c.node),
                Role::Container => container = Some(c.node),
                Role::Ignore => {}
            }
        }
        let Some((node, kind, tag)) = def else { continue };
        if names.is_empty() {
            continue;
        }
        names.sort_by_key(|n| n.start_byte());
        names.dedup_by_key(|n| n.id());
        let base = names.iter().map(|n| name_text(n, text)).collect::<Vec<_>>().join(".");
        if base.is_empty() {
            continue;
        }
        let (mut kind, mut base, mut container) =
            (kind, base, container.map(|c| strip_generics(&clean(node_text(&c, text), 120))));
        // C++ out-of-line definitions: `void Widget::draw()` is method `draw` of `Widget`.
        if kind == ItemKind::Symbol(SymbolKind::Function)
            && let Some((qualifier, last)) = base.rsplit_once("::")
            && !qualifier.is_empty()
        {
            container = Some(strip_generics(qualifier));
            base = last.to_owned();
            kind = ItemKind::Symbol(SymbolKind::Method);
        }
        let name = match (kind, trait_) {
            (ItemKind::Impl, Some(t)) => format!("impl {} for {base}", clean(node_text(&t, text), 120)),
            (ItemKind::Impl, None) => format!("impl {base}"),
            _ => base.clone(),
        };
        let container_name = match kind {
            ItemKind::Impl | ItemKind::Extension => strip_generics(&base),
            _ => base.clone(),
        };
        let first = names[0];
        let last = names[names.len() - 1];
        let sel = idx.range(first.start_byte(), last.end_byte());
        let raw = Raw {
            node_id: node.id(),
            pattern: m.pattern_index,
            start: node.start_byte(),
            end: trimmed_end(&node, text),
            range: idx.range(node.start_byte(), trimmed_end(&node, text)),
            sel,
            kind,
            tag,
            name,
            container_name,
            explicit_container: container,
            detail: detail.map(|d| clean(node_text(&d, text), 80)).filter(|d| !d.is_empty()),
        };
        match by_node.get(&raw.node_id) {
            Some(existing) if existing.pattern <= raw.pattern => {}
            _ => {
                by_node.insert(raw.node_id, raw);
            }
        }
    }
    let mut raws: Vec<Raw> = by_node.into_values().collect();
    raws.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)).then(a.pattern.cmp(&b.pattern)));
    build_tree(g, raws)
}

fn build_tree(g: &Grammar, raws: Vec<Raw>) -> Vec<Built> {
    // Stack of open items; an item is closed once a raw starts beyond its end.
    let mut roots: Vec<Built> = Vec::new();
    let mut stack: Vec<Built> = Vec::new();
    for raw in raws {
        while let Some(top) = stack.last() {
            if raw.start >= top.raw.start && raw.end <= top.raw.end {
                break;
            }
            let done = stack.pop().unwrap();
            push_child(&mut stack, &mut roots, done);
        }
        let parent_kind = stack.last().map(|p| p.raw.kind);
        let mut kind = raw.kind.symbol_kind();
        if kind == SymbolKind::Function && parent_kind.is_some_and(ItemKind::holds_methods) {
            kind = SymbolKind::Method;
        }
        if kind == SymbolKind::Method {
            let owner = raw.explicit_container.as_deref().or(stack.last().map(|p| p.raw.container_name.as_str()));
            let in_type = parent_kind.is_some_and(ItemKind::holds_methods) || raw.explicit_container.is_some();
            if in_type && (g.spec.constructors.contains(&raw.name.as_str()) || owner == Some(raw.name.as_str())) {
                kind = SymbolKind::Constructor;
            }
        }
        stack.push(Built { raw, kind, children: Vec::new() });
    }
    while let Some(done) = stack.pop() {
        push_child(&mut stack, &mut roots, done);
    }
    roots
}

fn push_child(stack: &mut [Built], roots: &mut Vec<Built>, item: Built) {
    match stack.last_mut() {
        Some(parent) => parent.children.push(item),
        None => roots.push(item),
    }
}

pub(crate) fn outline(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<OutlineItem> {
    fn convert(b: Built) -> OutlineItem {
        let detail = b.raw.detail.or(match b.raw.kind {
            ItemKind::Extension => Some("extension".to_owned()),
            _ => None,
        });
        OutlineItem {
            name: b.raw.name,
            detail,
            kind: b.kind,
            range: b.raw.range,
            selection_range: b.raw.sel,
            children: b.children.into_iter().map(convert).collect(),
        }
    }
    collect(g, q, tree, text).into_iter().map(convert).collect()
}

pub(crate) fn tags(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<SymbolTag> {
    fn walk(items: Vec<Built>, container: Option<&str>, out: &mut Vec<SymbolTag>) {
        for b in items {
            let own_container = b.raw.explicit_container.as_deref().or(container);
            if b.raw.tag && !matches!(b.raw.kind, ItemKind::Impl | ItemKind::Extension | ItemKind::Heading) {
                out.push(SymbolTag {
                    name: b.raw.name.clone(),
                    kind: b.kind,
                    container: own_container.map(str::to_owned),
                    range: b.raw.sel,
                });
            }
            let next = if b.raw.tag || matches!(b.raw.kind, ItemKind::Impl | ItemKind::Extension) {
                Some(b.raw.container_name.as_str())
            } else {
                container
            };
            walk(b.children, next, out);
        }
    }
    let mut out = Vec::new();
    walk(collect(g, q, tree, text), None, &mut out);
    out
}

/// End of `node` without trailing whitespace (C macros and others include the newline).
fn trimmed_end(node: &Node, text: &str) -> usize {
    let (s, e) = (node.start_byte(), node.end_byte());
    text.get(s..e).map_or(e, |t| s + t.trim_end().len())
}

fn node_text<'t>(n: &Node, text: &'t str) -> &'t str {
    text.get(n.start_byte()..n.end_byte()).unwrap_or_default()
}

fn name_text(n: &Node, text: &str) -> String {
    let t = node_text(n, text);
    // Ruby / Elixir symbols: `:total` -> `total`.
    let t = if matches!(n.kind(), "simple_symbol" | "atom") { t.trim_start_matches(':') } else { t };
    clean(t, 120)
}

/// Collapses whitespace runs, strips surrounding quotes and truncates to `max` chars.
fn clean(s: &str, max: usize) -> String {
    let s = s.trim();
    let s = s
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))
        .or_else(|| s.strip_prefix('`').and_then(|r| r.strip_suffix('`')))
        .unwrap_or(s);
    let mut out = String::with_capacity(s.len().min(max + 1));
    let mut count = 0;
    let mut pending_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= max {
            out.push('…');
            break;
        }
        out.push(c);
        count += 1;
    }
    out
}

/// `Foo<T>` -> `Foo`, `*Foo` -> `Foo`, `&mut Foo` -> `Foo`.
fn strip_generics(s: &str) -> String {
    let s = s.trim_start_matches(['*', '&']).trim_start_matches("mut ").trim();
    let end = s.find(['<', '[', '(']).unwrap_or(s.len());
    s[..end].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(clean("  \"a  b\n c\" ", 80), "a b c");
        assert_eq!(clean("abcdef", 3), "abc…");
        assert_eq!(strip_generics("Foo<T: Clone>"), "Foo");
        assert_eq!(strip_generics("*Server"), "Server");
    }
}
