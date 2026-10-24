//! Tree-sitter driven structure: outline, folding, symbol tags, selection ranges, highlighting.

mod cache;
mod folding;
mod grammars;
mod highlight;
pub(crate) mod lines;
mod outline;
mod selection;

use crate::{FoldRange, LanguageConfig, LanguageRegistry, SymbolTag};
pub use cache::{MAX_CACHED_TREES, SyntaxCache, SyntaxCacheStats};
use grammars::{SPECS, Spec};
pub use highlight::{SyntaxHighlightKind, SyntaxHighlights};
use ide_core::{LanguageId, OutlineItem, Range};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;
use tree_sitter::{Language, Parser, Tree};

/// Texts larger than this are not parsed (minified bundles, generated dumps).
pub const MAX_PARSE_BYTES: usize = 16 * 1024 * 1024;

/// Tree-sitter driven analysis. Parsers are pooled per thread; trees for open
/// documents are cached and incrementally re-parsed by `ide-language` users.
pub struct Syntax {
    grammars: Vec<Grammar>,
    /// Language id (and grammar name) -> index into `grammars`.
    by_lang: HashMap<String, usize>,
}

pub(crate) struct Grammar {
    pub(crate) spec: &'static Spec,
    pub(crate) language: Language,
    outline: OnceLock<Option<outline::OutlineQuery>>,
    highlights: OnceLock<Option<highlight::HighlightQuery>>,
    kinds: OnceLock<folding::KindTable>,
}

impl Grammar {
    fn kinds(&self) -> &folding::KindTable {
        self.kinds.get_or_init(|| folding::KindTable::new(self.spec, &self.language))
    }

    fn outline_query(&self) -> Option<&outline::OutlineQuery> {
        self.outline
            .get_or_init(|| match outline::OutlineQuery::new(&self.language, self.spec.outline) {
                Ok(q) => Some(q),
                Err(e) => {
                    tracing::error!("outline query for {} is invalid: {e}", self.spec.name);
                    None
                }
            })
            .as_ref()
    }

    fn highlight_query(&self) -> Option<&highlight::HighlightQuery> {
        self.highlights
            .get_or_init(|| {
                let h = self.spec.highlights.as_ref()?;
                highlight::HighlightQuery::new(&self.language, h.query, h.first_wins)
                    .inspect_err(|e| tracing::error!("highlights query for {} is invalid: {e}", self.spec.name))
                    .ok()
            })
            .as_ref()
    }
}

thread_local! {
    static PARSER: RefCell<Parser> = RefCell::new(Parser::new());
}

impl Syntax {
    /// Maps the built-in language definitions onto the bundled grammars.
    pub fn new() -> Self {
        let configs = LanguageRegistry::load(None).map(|r| r.all()).unwrap_or_default();
        Self::with_languages(&configs)
    }

    /// Maps `languages` (by their `tree-sitter` field) onto the bundled grammars.
    /// Grammar names are always accepted as language ids too.
    pub fn with_languages(languages: &[LanguageConfig]) -> Self {
        let grammars: Vec<Grammar> = SPECS
            .iter()
            .map(|spec| Grammar {
                spec,
                language: Language::new(spec.language),
                outline: OnceLock::new(),
                highlights: OnceLock::new(),
                kinds: OnceLock::new(),
            })
            .collect();
        let mut by_lang: HashMap<String, usize> =
            grammars.iter().enumerate().map(|(i, g)| (g.spec.name.to_owned(), i)).collect();
        for cfg in languages {
            if let Some(name) = cfg.tree_sitter.as_deref() {
                match grammars.iter().position(|g| g.spec.name == name) {
                    Some(i) => {
                        by_lang.insert(cfg.id.as_str().to_owned(), i);
                    }
                    None => tracing::debug!("language {}: tree-sitter grammar {name} is not bundled", cfg.id),
                }
            }
        }
        Self { grammars, by_lang }
    }

    /// Names of the bundled grammars (valid values for `tree-sitter = "..."`).
    pub fn grammar_names() -> impl Iterator<Item = &'static str> {
        SPECS.iter().map(|s| s.name)
    }

    /// Changes whenever extraction output may change (grammar set, queries,
    /// crate version); persistent caches of [`Syntax::tags`] key on it.
    pub fn fingerprint(&self) -> String {
        static FP: OnceLock<String> = OnceLock::new();
        FP.get_or_init(|| {
            let mut h = blake3::Hasher::new();
            h.update(env!("CARGO_PKG_VERSION").as_bytes());
            for s in SPECS {
                h.update(s.name.as_bytes());
                h.update(&Language::new(s.language).abi_version().to_le_bytes());
                h.update(s.outline.as_bytes());
                for list in [s.fold_nodes, s.fold_bodies, s.imports, s.constructors] {
                    for k in list {
                        h.update(k.as_bytes());
                        h.update(b"\0");
                    }
                }
            }
            h.finalize().to_hex()[..16].to_owned()
        })
        .clone()
    }

    /// Whether a tree-sitter grammar is bundled for this language.
    pub fn supports(&self, lang: &LanguageId) -> bool {
        self.by_lang.contains_key(lang.as_str())
    }

    /// Whether [`Syntax::tags`] can return anything for this language (data
    /// formats such as JSON only have an outline). Lets indexers skip parsing.
    pub fn has_symbols(&self, lang: &LanguageId) -> bool {
        self.grammar(lang).and_then(Grammar::outline_query).is_some_and(|q| q.has_tags)
    }

    pub fn outline(&self, lang: &LanguageId, text: &str) -> Vec<OutlineItem> {
        self.analyze(lang, text, |g, tree, text| {
            let query = g.outline_query()?;
            Some(outline::outline(g, query, tree, text))
        })
        .unwrap_or_default()
    }

    pub fn folding(&self, lang: &LanguageId, text: &str) -> Vec<FoldRange> {
        self.analyze(lang, text, |g, tree, text| Some(folding::folding(g.spec, g.kinds(), tree, text)))
            .unwrap_or_default()
    }

    pub fn tags(&self, lang: &LanguageId, text: &str) -> Vec<SymbolTag> {
        self.analyze(lang, text, |g, tree, text| {
            let query = g.outline_query()?;
            Some(outline::tags(g, query, tree, text))
        })
        .unwrap_or_default()
    }

    /// Highlighting from the grammar's own query; `None` without one.
    pub fn highlights(&self, lang: &LanguageId, text: &str) -> Option<SyntaxHighlights> {
        self.analyze(lang, text, |g, tree, text| {
            Some(SyntaxHighlights::new(highlight::highlights(g.highlight_query()?, tree, text)))
        })
    }

    /// Syntax-aware selection ranges for IDEA "Extend Selection" (⌥↑), innermost first.
    pub fn selection_ranges(&self, lang: &LanguageId, text: &str, offset_utf16: u32) -> Vec<Range> {
        match self.analyze(lang, text, |_, tree, text| Some(selection::selection_ranges(tree, text, offset_utf16))) {
            Some(ranges) => ranges,
            None => selection::plain_selection_ranges(text, offset_utf16),
        }
    }

    /// Name of the bundled grammar used for `lang`, if any.
    pub fn grammar_name(&self, lang: &LanguageId) -> Option<&'static str> {
        self.grammar(lang).map(|g| g.spec.name)
    }

    /// Grammar name and tree-sitter language for `lang`, for engines that parse
    /// on their own (structural search patterns).
    pub fn ts_language(&self, lang: &LanguageId) -> Option<(&'static str, Language)> {
        self.grammar(lang).map(|g| (g.spec.name, g.language.clone()))
    }

    /// Parses `text` from scratch (cancellable) and lends the tree to `f`.
    /// Prefer [`SyntaxCache::with_parsed`] for open documents.
    pub fn with_parsed<R>(
        &self,
        lang: &LanguageId,
        text: &str,
        cancelled: &dyn Fn() -> bool,
        f: impl FnOnce(ParsedTree<'_>) -> R,
    ) -> Result<R, TreeError> {
        let g = self.grammar(lang).ok_or(TreeError::Unsupported)?;
        if text.len() > MAX_PARSE_BYTES {
            return Err(TreeError::TooLarge);
        }
        let tree = parse_cancellable(&g.language, text, None, cancelled)?;
        Ok(f(ParsedTree { grammar: g.spec.name, language: &g.language, tree: &tree, text }))
    }

    /// Parses `text` with the grammar for `lang` and returns the tree's S-expression
    /// (debugging aid for writing queries).
    pub fn debug_tree(&self, lang: &LanguageId, text: &str) -> Option<String> {
        self.analyze(lang, text, |_, tree, _| Some(tree.root_node().to_sexp()))
    }

    fn grammar(&self, lang: &LanguageId) -> Option<&Grammar> {
        self.by_lang.get(lang.as_str()).map(|&i| &self.grammars[i])
    }

    fn analyze<R>(
        &self,
        lang: &LanguageId,
        text: &str,
        f: impl FnOnce(&Grammar, &Tree, &str) -> Option<R>,
    ) -> Option<R> {
        let g = self.grammar(lang)?;
        if text.len() > MAX_PARSE_BYTES {
            return None;
        }
        let tree = parse(&g.language, text, None)?;
        f(g, &tree, text)
    }
}

impl Default for Syntax {
    fn default() -> Self {
        Self::new()
    }
}

/// Parses `text`; `old` (already `edit`ed to match `text`) makes it incremental.
fn parse(language: &Language, text: &str, old: Option<&Tree>) -> Option<Tree> {
    parse_cancellable(language, text, old, &|| false).ok()
}

/// [`parse`] that gives up once `cancelled` returns true (polled while parsing).
fn parse_cancellable(
    language: &Language,
    text: &str,
    old: Option<&Tree>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Tree, TreeError> {
    PARSER.with(|p| {
        let mut parser = p.borrow_mut();
        if let Err(e) = parser.set_language(language) {
            tracing::error!("incompatible tree-sitter grammar: {e}");
            return Err(TreeError::Unsupported);
        }
        let bytes = text.as_bytes();
        let mut read = |i: usize, _: tree_sitter::Point| bytes.get(i..).unwrap_or_default();
        let mut progress = |_: &tree_sitter::ParseState| cancelled();
        let options = tree_sitter::ParseOptions::new().progress_callback(&mut progress);
        let tree = parser.parse_with_options(&mut read, old, Some(options));
        if tree.is_none() {
            parser.reset();
        }
        tree.ok_or(if cancelled() { TreeError::Cancelled } else { TreeError::Unsupported })
    })
}

/// Why no tree is available for a text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeError {
    /// No bundled grammar for the language.
    Unsupported,
    /// The text exceeds [`MAX_PARSE_BYTES`].
    TooLarge,
    Cancelled,
}

/// A syntax tree for one text snapshot, lent to analysis crates (`ide-syntax`).
pub struct ParsedTree<'a> {
    /// Bundled grammar name (as in `tree-sitter = "<name>"`).
    pub grammar: &'static str,
    pub language: &'a Language,
    pub tree: &'a Tree,
    pub text: &'a str,
}

#[cfg(test)]
mod tests;
