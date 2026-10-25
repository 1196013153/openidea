//! Comments and string literals of a text, for Find in Files' search context
//! filter ("In comments", "Except string literals", …).

use super::folding::is_comment;
use tree_sitter::{Node, Tree};

/// What a [`Literal`] range is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiteralKind {
    Comment,
    String,
}

/// A comment or string literal: byte range of the outermost node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Literal {
    pub start: usize,
    pub end: usize,
    pub kind: LiteralKind,
}

fn kind_of(node: &Node<'_>) -> Option<LiteralKind> {
    if !node.is_named() {
        return None;
    }
    let kind = node.kind();
    if is_comment(kind) {
        Some(LiteralKind::Comment)
    } else if kind.contains("string") || matches!(kind, "char_literal" | "character_literal" | "rune_literal") {
        Some(LiteralKind::String)
    } else {
        None
    }
}

/// Comments and string literals in document order; nested ones (a string in a
/// comment, interpolations) are covered by the outermost.
pub(crate) fn literals(tree: &Tree) -> Vec<Literal> {
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        let kind = kind_of(&node);
        if let Some(kind) = kind {
            out.push(Literal { start: node.start_byte(), end: node.end_byte(), kind });
        }
        if kind.is_none() && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return out;
            }
        }
    }
}
