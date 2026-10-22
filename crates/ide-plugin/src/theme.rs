//! Theme contributions: design-token overrides applied as CSS variables on `:root`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

const MAX_TOKENS: usize = 512;
const MAX_VALUE_LEN: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeKind {
    Dark,
    Light,
}

/// `{"id", "name", "kind", "tokens": {"--bg-app": "#002b36", ...}}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDef {
    pub id: String,
    pub name: String,
    pub kind: ThemeKind,
    pub tokens: BTreeMap<String, String>,
}

impl ThemeDef {
    pub fn parse(src: &str) -> Result<Self, String> {
        let theme: Self = serde_json::from_str(src).map_err(|e| format!("invalid theme JSON: {e}"))?;
        theme.validate()?;
        Ok(theme)
    }

    pub fn validate(&self) -> Result<(), String> {
        crate::manifest::validate_command_id(&self.id).map_err(|e| e.replace("command id", "theme id"))?;
        if self.name.trim().is_empty() {
            return Err("theme name must not be empty".into());
        }
        if self.tokens.len() > MAX_TOKENS {
            return Err(format!("too many tokens (max {MAX_TOKENS})"));
        }
        for (name, value) in &self.tokens {
            let valid_name = name.len() > 2
                && name.len() <= 64
                && name.starts_with("--")
                && name[2..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !valid_name {
                return Err(format!("invalid token name {name:?}: expected a CSS variable like --bg-app"));
            }
            if !is_safe_value(value) {
                return Err(format!("token {name}: unsupported value {value:?}"));
            }
        }
        Ok(())
    }
}

/// Values are plain CSS values (colours, lengths, font stacks). Anything that
/// could break out of the declaration or fetch resources is rejected.
fn is_safe_value(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    !v.trim().is_empty()
        && v.len() <= MAX_VALUE_LEN
        && !v.chars().any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r'))
        && !lower.contains("url(")
        && !lower.contains("image(")
        && !lower.contains("@import")
        && !lower.contains("expression(")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates() {
        let t = ThemeDef::parse(r##"{"id":"sol","name":"Sol","kind":"dark","tokens":{"--bg-app":"#002b36","--font-ui":"'Inter', sans-serif"}}"##)
            .unwrap();
        assert_eq!(t.kind, ThemeKind::Dark);
        assert_eq!(t.tokens["--bg-app"], "#002b36");
    }

    #[test]
    fn rejects_unsafe_tokens() {
        let mk = |k: &str, v: &str| {
            ThemeDef { id: "t".into(), name: "T".into(), kind: ThemeKind::Light, tokens: [(k.into(), v.into())].into() }
                .validate()
        };
        assert!(mk("--bg", "red").is_ok());
        assert!(mk("bg", "red").is_err());
        assert!(mk("--Bg", "red").is_err());
        assert!(mk("--bg", "red; color: blue").is_err());
        assert!(mk("--bg", "url(https://evil)").is_err());
        assert!(mk("--bg", "}body{").is_err());
        assert!(mk("--bg", " ").is_err());
        assert!(ThemeDef::parse("{\"id\":\"x\"}").is_err());
    }
}
