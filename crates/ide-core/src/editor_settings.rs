//! Settings › Editor sub-structures (IDEA's Editor group: General and its
//! sub-pages, Code Editing, Color Scheme, Code Style, File Encodings). The
//! top-level `EditorSettings` lives in `settings.rs` and embeds these.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Editor › General (mouse, scrolling, soft wraps, virtual space, saving).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorGeneralSettings {
    /// Change font size with ⌘ + mouse wheel.
    pub wheel_zoom: bool,
    /// Drag-and-drop of selected text inside the editor.
    pub drag_and_drop: bool,
    /// When the caret moves out of view: `minimize` scrolling | `center` the caret line.
    pub caret_scroll: String,
    /// Glob patterns (`;`-separated) of files soft-wrapped when `editor.softWrap` is on.
    pub soft_wrap_files: String,
    /// Wrapped parts keep the original line's indent.
    pub soft_wrap_indent: bool,
    /// Show virtual space at the file bottom.
    pub scroll_past_end: bool,
    /// Remove trailing spaces on save from: `modified` lines | `all` lines.
    pub strip_trailing_scope: String,
    /// Keep trailing spaces on the caret line when stripping.
    pub keep_trailing_on_caret_line: bool,
    pub remove_trailing_blank_lines: bool,
    /// Copy as rich text (HTML with syntax colours) by default.
    pub rich_text_copy: bool,
}

impl Default for EditorGeneralSettings {
    fn default() -> Self {
        Self {
            wheel_zoom: false,
            drag_and_drop: true,
            caret_scroll: "minimize".into(),
            soft_wrap_files: "*.md; *.txt; *.rst; *.adoc".into(),
            soft_wrap_indent: true,
            scroll_past_end: true,
            strip_trailing_scope: "modified".into(),
            keep_trailing_on_caret_line: true,
            remove_trailing_blank_lines: false,
            rich_text_copy: true,
        }
    }
}

/// Editor › General › Appearance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorAppearanceSettings {
    pub caret_blinking: bool,
    /// Blink period in ms.
    pub caret_blink_period: u32,
    pub block_caret: bool,
    pub line_numbers: bool,
    pub method_separators: bool,
    /// Sub-options of `editor.showWhitespace`.
    pub whitespace_leading: bool,
    pub whitespace_inner: bool,
    pub whitespace_trailing: bool,
    pub indent_guides: bool,
    /// Right margin and visual guides from Code Style.
    pub hard_wrap_guides: bool,
    pub intention_bulb: bool,
    /// Distraction Free Mode: width of the centred text column, in characters.
    pub distraction_free_width: u32,
}

impl Default for EditorAppearanceSettings {
    fn default() -> Self {
        Self {
            caret_blinking: true,
            caret_blink_period: 500,
            block_caret: false,
            line_numbers: true,
            method_separators: false,
            whitespace_leading: true,
            whitespace_inner: true,
            whitespace_trailing: true,
            indent_guides: true,
            hard_wrap_guides: true,
            intention_bulb: true,
            distraction_free_width: 80,
        }
    }
}

/// Editor › General › Breadcrumbs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct BreadcrumbsSettings {
    pub show: bool,
    /// `top` | `bottom` of the editor.
    pub placement: String,
    /// Language ids breadcrumbs are turned off for.
    pub disabled_languages: Vec<String>,
}

impl Default for BreadcrumbsSettings {
    fn default() -> Self {
        Self { show: false, placement: "bottom".into(), disabled_languages: Vec::new() }
    }
}

/// Editor › General › Code Completion.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CompletionSettings {
    pub match_case: bool,
    /// `first` letter only | `all` letters.
    pub case_sensitivity: String,
    /// Show suggestions as you type.
    pub auto_popup: bool,
    /// Insert the selected suggestion by pressing space, dot, or other context-dependent keys.
    pub insert_on_special_keys: bool,
    pub show_documentation: bool,
    pub documentation_delay: u32,
    pub parameter_info: bool,
    pub parameter_info_delay: u32,
}

impl Default for CompletionSettings {
    fn default() -> Self {
        Self {
            match_case: true,
            case_sensitivity: "first".into(),
            auto_popup: true,
            insert_on_special_keys: false,
            show_documentation: true,
            documentation_delay: 500,
            parameter_info: true,
            parameter_info_delay: 300,
        }
    }
}

/// Editor › General › Auto Import (LSP code actions).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AutoImportSettings {
    pub add_unambiguous: bool,
    pub optimize_on_the_fly: bool,
}

/// Editor › General › Code Folding.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct FoldingSettings {
    pub show_outline: bool,
    pub file_header: bool,
    pub imports: bool,
    pub doc_comments: bool,
}

impl Default for FoldingSettings {
    fn default() -> Self {
        Self { show_outline: true, file_header: true, imports: true, doc_comments: false }
    }
}

/// Editor › General › Editor Tabs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorTabsSettings {
    /// `top` | `none`.
    pub placement: String,
    pub multiple_rows: bool,
    pub show_extension: bool,
    /// Mark modified tabs with an asterisk.
    pub mark_modified: bool,
    pub show_close_button: bool,
    pub preview_tab: bool,
    pub open_at_end: bool,
    pub tab_limit: u32,
    /// When the limit is reached close `unchanged` (non-modified) tabs first, or the `lru` one.
    pub closing_policy: String,
    /// When the current tab is closed activate the `left` | `right` | `mru` tab.
    pub activate_on_close: String,
}

impl Default for EditorTabsSettings {
    fn default() -> Self {
        Self {
            placement: "top".into(),
            multiple_rows: false,
            show_extension: true,
            mark_modified: false,
            show_close_button: true,
            preview_tab: true,
            open_at_end: false,
            tab_limit: 10,
            closing_policy: "unchanged".into(),
            activate_on_close: "mru".into(),
        }
    }
}

/// Editor › General › Smart Keys.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SmartKeysSettings {
    /// Home moves caret to first non-whitespace character.
    pub smart_home: bool,
    /// Use "CamelHumps" words.
    pub camel_humps: bool,
    pub pair_brackets: bool,
    pub pair_quotes: bool,
    pub surround_selection: bool,
    pub tab_out_of_pair: bool,
    /// Reformat on paste: `none` | `indentBlock` | `indentEachLine`.
    pub reformat_on_paste: String,
    pub smart_indent: bool,
    /// Backspace › Unindent: `nearest` indent position | `none`.
    pub backspace_unindent: String,
}

impl Default for SmartKeysSettings {
    fn default() -> Self {
        Self {
            smart_home: true,
            camel_humps: false,
            pair_brackets: true,
            pair_quotes: true,
            surround_selection: true,
            tab_out_of_pair: false,
            reformat_on_paste: "indentBlock".into(),
            smart_indent: true,
            backspace_unindent: "nearest".into(),
        }
    }
}

/// Editor › Code Editing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeEditingSettings {
    /// Highlight usages of element at caret.
    pub highlight_usages: bool,
    pub highlight_braces: bool,
    /// Highlight other occurrences of the selected text.
    pub highlight_selection: bool,
    pub quick_doc_on_hover: bool,
    pub quick_doc_delay: u32,
    /// Next / previous error goes to errors only (skips warnings).
    pub next_error_errors_only: bool,
    pub sticky_lines_max: u32,
}

impl Default for CodeEditingSettings {
    fn default() -> Self {
        Self {
            highlight_usages: true,
            highlight_braces: true,
            highlight_selection: true,
            quick_doc_on_hover: true,
            quick_doc_delay: 500,
            next_error_errors_only: true,
            sticky_lines_max: 5,
        }
    }
}

/// Editor › Inlay Hints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct InlayHintsSettings {
    pub types: bool,
    pub parameters: bool,
    /// Hints of other kinds (chaining, closing labels…).
    pub other: bool,
    pub disabled_languages: Vec<String>,
    /// Code vision: usages above declarations.
    pub code_vision_usages: bool,
}

impl Default for InlayHintsSettings {
    fn default() -> Self {
        Self { types: true, parameters: true, other: true, disabled_languages: Vec::new(), code_vision_usages: true }
    }
}

/// Editor › Color Scheme override of one text attribute.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TextAttributesOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// `underline` | `wave` | `strikeout` | `none`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_color: Option<String>,
}

/// Editor › Code Style › <Language> › Tabs and Indents (unset fields inherit).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LanguageCodeStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_tab: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hard_wrap_at: Option<u32>,
}

/// Editor › Code Style (General tab + per-language overrides).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeStyleSettings {
    /// Line separator for new files: `system` | `lf` | `crlf` | `cr`.
    pub line_separator: String,
    pub hard_wrap_at: u32,
    pub visual_guides: Vec<u32>,
    /// Detect and use existing file indents for editing.
    pub detect_indents: bool,
    /// Enable EditorConfig support.
    pub editorconfig: bool,
    pub languages: BTreeMap<String, LanguageCodeStyle>,
}

impl Default for CodeStyleSettings {
    fn default() -> Self {
        Self {
            line_separator: "system".into(),
            hard_wrap_at: 120,
            visual_guides: Vec::new(),
            detect_indents: true,
            editorconfig: true,
            languages: BTreeMap::new(),
        }
    }
}

/// Editor › File Encodings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct EncodingSettings {
    /// Fallback for files outside the project that are not valid UTF-8 (WHATWG label).
    pub global: String,
    /// Encoding of new files and fallback for project files that are not valid UTF-8.
    pub project: String,
    /// Fallback for `.properties` files.
    pub properties: String,
    /// Create UTF-8 files: `never` (no BOM) | `always` (with BOM) | `windows` (with BOM on Windows).
    pub utf8_bom: String,
}

impl Default for EncodingSettings {
    fn default() -> Self {
        Self {
            global: "utf-8".into(),
            project: "utf-8".into(),
            properties: "iso-8859-1".into(),
            utf8_bom: "never".into(),
        }
    }
}
