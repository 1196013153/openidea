//! Syntax highlighting from a grammar's own `highlights.scm`, for languages the
//! UI has no CodeMirror mode for.
//!
//! Capture names follow the nvim-treesitter / Zed conventions (`@keyword`,
//! `@string.special.symbol`, ...) and are folded into [`SyntaxHighlightKind`] by
//! their longest known dotted prefix. Overlaps resolve the way those editors
//! do: a smaller node wins over the node containing it, and for the same node
//! the later pattern wins. `@embedded` (string interpolation) clears the
//! surrounding colour.

use super::lines::LineIndex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::{Language, Query, QueryCursor, StreamingIterator, Tree};

/// Highlight classes sent to the UI, which maps each onto a Lezer tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxHighlightKind {
    Keyword,
    String,
    StringSpecial,
    Escape,
    Regexp,
    Atom,
    Number,
    Constant,
    Comment,
    DocComment,
    Function,
    FunctionCall,
    Builtin,
    Type,
    Namespace,
    Variable,
    SelfVariable,
    Property,
    Attribute,
    Macro,
    Label,
    Tag,
    Operator,
    Punctuation,
}

impl SyntaxHighlightKind {
    /// Every kind, in `as u32` order: the legend for [`SyntaxHighlights::data`].
    pub const ALL: [Self; 24] = [
        Self::Keyword,
        Self::String,
        Self::StringSpecial,
        Self::Escape,
        Self::Regexp,
        Self::Atom,
        Self::Number,
        Self::Constant,
        Self::Comment,
        Self::DocComment,
        Self::Function,
        Self::FunctionCall,
        Self::Builtin,
        Self::Type,
        Self::Namespace,
        Self::Variable,
        Self::SelfVariable,
        Self::Property,
        Self::Attribute,
        Self::Macro,
        Self::Label,
        Self::Tag,
        Self::Operator,
        Self::Punctuation,
    ];
}

/// Highlighted ranges of a whole document, packed like LSP semantic tokens.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxHighlights {
    /// Legend: `data` kind `i` is `kinds[i]`.
    pub kinds: Vec<SyntaxHighlightKind>,
    /// `[from, to, kind]` triples: sorted, non-overlapping UTF-16 offsets.
    pub data: Vec<u32>,
}

impl SyntaxHighlights {
    pub(crate) fn new(data: Vec<u32>) -> Self {
        Self { kinds: SyntaxHighlightKind::ALL.to_vec(), data }
    }
}

/// What a capture paints over its node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Paint {
    Kind(SyntaxHighlightKind),
    /// `@embedded`: code inside a string, uncoloured unless captured itself.
    Clear,
}

/// Capture name prefixes, most specific first within each family.
const CAPTURES: &[(&str, Paint)] = {
    use Paint::{Clear, Kind};
    use SyntaxHighlightKind as K;
    &[
        ("embedded", Clear),
        ("keyword", Kind(K::Keyword)),
        ("include", Kind(K::Keyword)),
        ("import", Kind(K::Keyword)),
        ("conditional", Kind(K::Keyword)),
        ("repeat", Kind(K::Keyword)),
        ("exception", Kind(K::Keyword)),
        ("boolean", Kind(K::Keyword)),
        ("string.escape", Kind(K::Escape)),
        ("escape", Kind(K::Escape)),
        ("string.regex", Kind(K::Regexp)),
        ("string.regexp", Kind(K::Regexp)),
        ("string.special.symbol", Kind(K::Atom)),
        ("symbol", Kind(K::Atom)),
        ("string.special", Kind(K::StringSpecial)),
        ("string", Kind(K::String)),
        ("character", Kind(K::String)),
        ("number", Kind(K::Number)),
        ("float", Kind(K::Number)),
        ("constant.builtin", Kind(K::Constant)),
        ("constant.macro", Kind(K::Macro)),
        ("constant", Kind(K::Constant)),
        // nvim greys out unused bindings (`_acc`); IDEA shows them as variables.
        ("comment.unused", Kind(K::Variable)),
        ("comment.doc", Kind(K::DocComment)),
        ("comment.documentation", Kind(K::DocComment)),
        ("comment", Kind(K::Comment)),
        ("function.builtin", Kind(K::Builtin)),
        ("function.macro", Kind(K::Macro)),
        ("function.definition", Kind(K::Function)),
        ("function", Kind(K::FunctionCall)),
        ("method", Kind(K::FunctionCall)),
        ("constructor", Kind(K::Type)),
        ("type.builtin", Kind(K::Builtin)),
        ("type", Kind(K::Type)),
        ("module", Kind(K::Namespace)),
        ("namespace", Kind(K::Namespace)),
        ("variable.builtin", Kind(K::SelfVariable)),
        ("variable.member", Kind(K::Property)),
        ("variable.field", Kind(K::Property)),
        ("variable", Kind(K::Variable)),
        ("parameter", Kind(K::Variable)),
        ("property", Kind(K::Property)),
        ("field", Kind(K::Property)),
        ("attribute", Kind(K::Attribute)),
        ("label", Kind(K::Label)),
        ("tag", Kind(K::Tag)),
        ("operator", Kind(K::Operator)),
        ("punctuation", Kind(K::Punctuation)),
    ]
};

/// The paint for a capture name: its longest prefix (on `.` boundaries) in
/// [`CAPTURES`]. Private captures (`@__name__`) and unknown names paint nothing.
fn paint_for(name: &str) -> Option<Paint> {
    if name.starts_with('_') {
        return None;
    }
    let mut prefix = name;
    loop {
        if let Some((_, p)) = CAPTURES.iter().find(|(n, _)| *n == prefix) {
            return Some(*p);
        }
        prefix = &prefix[..prefix.rfind('.')?];
    }
}

pub(crate) struct HighlightQuery {
    query: Query,
    /// By capture index.
    paints: Vec<Option<Paint>>,
}

impl HighlightQuery {
    pub(crate) fn new(language: &Language, source: &str) -> Result<Self, tree_sitter::QueryError> {
        let query = Query::new(language, source)?;
        let paints = query.capture_names().iter().map(|n| paint_for(n)).collect();
        Ok(Self { query, paints })
    }
}

/// Byte value for "no colour" in the paint buffer; kinds are `1 + index`.
const NONE: u8 = 0;

/// `[from, to, kind]` UTF-16 triples for `text`; see [`SyntaxHighlights::data`].
pub(crate) fn highlights(q: &HighlightQuery, tree: &Tree, text: &str) -> Vec<u32> {
    // (byte len, pattern, start, end, paint): painted largest first, then in
    // pattern order, so inner nodes and later patterns overwrite.
    let mut captures: Vec<(usize, usize, usize, usize, Paint)> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&q.query, tree.root_node(), text.as_bytes());
    while let Some(m) = matches.next() {
        for c in m.captures {
            if let Some(paint) = q.paints[c.index as usize] {
                let r = c.node.byte_range();
                if r.start < r.end {
                    captures.push((r.end - r.start, m.pattern_index, r.start, r.end, paint));
                }
            }
        }
    }
    captures.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut painted = vec![NONE; text.len()];
    for &(_, _, start, end, paint) in &captures {
        let v = match paint {
            Paint::Kind(k) => 1 + k as u8,
            Paint::Clear => NONE,
        };
        painted[start..end].fill(v);
    }

    let lines = LineIndex::new(text);
    let mut data = Vec::new();
    let mut i = 0;
    while i < painted.len() {
        let v = painted[i];
        let start = i;
        while i < painted.len() && painted[i] == v {
            i += 1;
        }
        // Node boundaries are char boundaries; whitespace-only runs stay uncoloured.
        if v != NONE && text.is_char_boundary(start) && text.is_char_boundary(i) && !text[start..i].trim().is_empty() {
            data.extend([lines.utf16_at(start) as u32, lines.utf16_at(i) as u32, (v - 1) as u32]);
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_names_fold_to_the_longest_known_prefix() {
        use SyntaxHighlightKind as K;
        assert_eq!(paint_for("keyword.function"), Some(Paint::Kind(K::Keyword)));
        assert_eq!(paint_for("string.special.symbol"), Some(Paint::Kind(K::Atom)));
        assert_eq!(paint_for("string.special.path"), Some(Paint::Kind(K::StringSpecial)));
        assert_eq!(paint_for("comment.doc.__attribute__"), Some(Paint::Kind(K::DocComment)));
        assert_eq!(paint_for("punctuation.bracket"), Some(Paint::Kind(K::Punctuation)));
        assert_eq!(paint_for("embedded"), Some(Paint::Clear));
        assert_eq!(paint_for("__name__"), None);
        assert_eq!(paint_for("spell"), None);
    }

    /// `(text, kind)` of every highlighted range.
    fn spans(lang: &str, text: &str) -> Vec<(String, SyntaxHighlightKind)> {
        let h = crate::Syntax::new().highlights(&ide_core::LanguageId::new(lang), text).unwrap();
        let units: Vec<u16> = text.encode_utf16().collect();
        h.data
            .chunks(3)
            .map(|t| (String::from_utf16(&units[t[0] as usize..t[1] as usize]).unwrap(), h.kinds[t[2] as usize]))
            .collect()
    }

    #[test]
    fn highlights_elixir() {
        use SyntaxHighlightKind as K;
        let src = "defmodule Greeter do\n  @moduledoc \"Hi\"\n  # 😀 note\n  def hello(name, _opts) do\n    IO.puts(\"Hello #{name}\")\n    :ok\n  end\nend\n";
        let got = spans("elixir", src);
        let kind = |t: &str| got.iter().find(|(s, _)| s == t).map(|(_, k)| *k);
        assert_eq!(kind("defmodule"), Some(K::Keyword));
        assert_eq!(kind("Greeter"), Some(K::Namespace));
        assert_eq!(kind("\"Hi\""), Some(K::DocComment));
        assert_eq!(kind("# 😀 note"), Some(K::Comment));
        assert_eq!(kind("def"), Some(K::Keyword));
        assert_eq!(kind("hello"), Some(K::FunctionCall));
        assert_eq!(kind("_opts"), Some(K::Variable));
        assert_eq!(kind("puts"), Some(K::FunctionCall));
        // Interpolation clears the string colour; its contents are coloured on their own.
        assert_eq!(kind("\"Hello "), Some(K::String));
        assert_eq!(kind("#{"), Some(K::Punctuation));
        assert_eq!(kind(":ok"), Some(K::Atom));
        assert_eq!(kind("end"), Some(K::Keyword));
        // Sorted and non-overlapping.
        let h = crate::Syntax::new().highlights(&ide_core::LanguageId::new("elixir"), src).unwrap();
        assert!(h.data.chunks(3).zip(h.data.chunks(3).skip(1)).all(|(a, b)| a[0] < a[1] && a[1] <= b[0]));
    }

    #[test]
    fn languages_without_a_query_have_none() {
        assert_eq!(crate::Syntax::new().highlights(&ide_core::LanguageId::new("rust"), "fn a() {}"), None);
    }

    #[test]
    fn legend_matches_discriminants() {
        for (i, k) in SyntaxHighlightKind::ALL.iter().enumerate() {
            assert_eq!(*k as usize, i);
        }
    }
}
