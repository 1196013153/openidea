/**
 * Editor › Code Style (General, Other File Types, one page per language from
 * `languages/*.toml`) and Editor › File Encodings. Indentation feeds the
 * editor's effective indent (EditorConfig › detected › language override ›
 * language definition › Other File Types); line separator and encodings feed
 * new-file creation in the backend (`ide-workspace::FileDefaults`).
 */
import { useId, useState } from "react";
import { Button, Checkbox, Input, type SelectOption } from "@/ui";
import { commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import { ENCODING_CHOICES, type LanguageCodeStyle } from "@/platform/editorSettings";
import { NumberInput, Row } from "../../components/Form";
import { useSetting } from "../../components/context";
import type { PageSpec } from "../spec";
import { editorPage } from "./kit";
import styles from "./Editor.module.css";

function VisualGuidesRow() {
  const [guides, setGuides] = useSetting<number[]>("editor.codeStyle.visualGuides");
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const parse = (t: string) =>
    t
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
  const text = draft ?? guides.join(", ");
  const invalid = draft !== null && parse(draft).some((n) => !Number.isInteger(n) || n < 1 || n > 999);
  return (
    <Row label="Visual guides" htmlFor={id} hint="Comma-separated column numbers, e.g. 80, 100.">
      <Input
        id={id}
        className={styles.guides}
        value={text}
        invalid={invalid}
        placeholder="Optional"
        onChange={(e) => {
          setDraft(e.target.value);
          const nums = parse(e.target.value);
          if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 999)) setGuides(nums);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className={styles.suffix}>columns</span>
    </Row>
  );
}

const LINE_SEPARATORS: SelectOption[] = [
  { value: "system", label: "System-Dependent" },
  { value: "lf", label: "Unix and macOS (\\n)" },
  { value: "crlf", label: "Windows (\\r\\n)" },
  { value: "cr", label: "Classic Mac OS (\\r)" },
];

const CODE_STYLE = editorPage({
  id: "editor.codeStyle",
  title: "Code Style",
  order: 24,
  projectScope: true,
  keywords: ["indent", "indentation", "tabs", "line separator", "editorconfig", "right margin"],
  sections: [
    {
      items: [
        {
          t: "select",
          key: "editor.codeStyle.lineSeparator",
          label: "Line separator",
          options: LINE_SEPARATORS,
          hint: "Used for new files.",
        },
        { t: "number", key: "editor.codeStyle.hardWrapAt", label: "Hard wrap at", min: 1, max: 999, unit: "columns" },
        { t: "custom", label: "Visual guides", component: VisualGuidesRow },
      ],
    },
    {
      title: "Indents Detection",
      items: [
        {
          t: "check",
          key: "editor.codeStyle.detectIndents",
          label: "Detect and use existing file indents for editing",
        },
      ],
    },
    {
      title: "EditorConfig",
      items: [
        {
          t: "check",
          key: "editor.codeStyle.editorconfig",
          label: "Enable EditorConfig support",
          hint: ".editorconfig files override indentation, line separators, encodings and save options.",
        },
      ],
    },
  ],
});

const OTHER = editorPage({
  id: "editor.codeStyle.other",
  title: "Other File Types",
  order: 1000,
  projectScope: true,
  keywords: ["tab size", "indent"],
  sections: [
    {
      title: "Tabs and Indents",
      items: [
        { t: "check", key: "editor.insertSpaces", label: "Use tab character", invert: true },
        { t: "number", key: "editor.tabSize", label: "Tab size", min: 1, max: 16 },
      ],
    },
  ],
});

/** Tabs and Indents of one language: overrides on top of the language definition. */
function LanguageStyle({ lang }: { lang: LanguageInfo }) {
  const [all, setAll] = useSetting<Record<string, LanguageCodeStyle>>("editor.codeStyle.languages");
  const [tabSize] = useSetting<number>("editor.tabSize");
  const [spaces] = useSetting<boolean>("editor.insertSpaces");
  const [wrap] = useSetting<number>("editor.codeStyle.hardWrapAt");
  const own = all?.[lang.id] ?? {};
  const base = { useTab: !(lang.indent?.insertSpaces ?? spaces), tabSize: lang.indent?.tabSize ?? tabSize };
  const eff = {
    useTab: own.useTab ?? base.useTab,
    tabSize: own.tabSize ?? base.tabSize,
    indent: own.indent ?? own.tabSize ?? base.tabSize,
    hardWrapAt: own.hardWrapAt ?? wrap,
  };
  const set = (patch: Partial<LanguageCodeStyle>) => {
    const next = { ...own, ...patch };
    setAll({ ...(all ?? {}), [lang.id]: next });
  };
  const reset = () => {
    const next = { ...(all ?? {}) };
    delete next[lang.id];
    setAll(next);
  };
  return (
    <div className={styles.page}>
      <section aria-label="Tabs and Indents">
        <div className={styles.previewTitle}>Tabs and Indents</div>
        <div className={styles.check}>
          <Checkbox checked={eff.useTab} onChange={(v) => set({ useTab: v })} label="Use tab character" />
        </div>
        <Row label="Tab size">
          <NumberInput
            value={eff.tabSize}
            onChange={(n) => set({ tabSize: n })}
            min={1}
            max={16}
            integer
            aria-label="Tab size"
          />
        </Row>
        <Row label="Indent">
          <NumberInput
            value={eff.indent}
            onChange={(n) => set({ indent: n })}
            min={1}
            max={16}
            integer
            aria-label="Indent"
          />
        </Row>
      </section>
      <section aria-label="Wrapping">
        <div className={styles.previewTitle}>Wrapping</div>
        <Row label="Hard wrap at" hint="Shown as the right margin guide in the editor.">
          <NumberInput
            value={eff.hardWrapAt}
            onChange={(n) => set({ hardWrapAt: n })}
            min={1}
            max={999}
            integer
            aria-label="Hard wrap at"
            unit="columns"
          />
        </Row>
      </section>
      <div className={styles.schemeRow}>
        <Button size="small" disabled={!all?.[lang.id]} onClick={reset}>
          Reset to Language Defaults
        </Button>
        <span className={styles.inherited}>
          Defaults from the {lang.name} language definition: {base.useTab ? "tab" : `${base.tabSize} spaces`}.
        </span>
      </div>
    </div>
  );
}

const SKIP = new Set(["plaintext", "log", "diff", "ignore", "gitattributes"]);

/** One Code Style page per language (registered once the language list is known). */
export async function codeStyleLanguagePages(): Promise<PageSpec[]> {
  if (!isTauri()) return [];
  const langs = await commands.languages();
  return langs
    .filter((l) => !SKIP.has(l.id))
    .map((lang) => ({
      id: `editor.codeStyle.${lang.id}`,
      title: lang.name,
      group: "Editor",
      order: 100,
      projectScope: true,
      keywords: ["Tabs and Indents", "Tab size", "Indent", "Use tab character", "Hard wrap at"],
      component: () => <LanguageStyle lang={lang} />,
    }));
}

const ENCODINGS: SelectOption[] = ENCODING_CHOICES.map(([value, label]) => ({ value, label }));

const ENCODINGS_PAGE = editorPage({
  id: "editor.fileEncodings",
  title: "File Encodings",
  order: 27,
  projectScope: true,
  keywords: ["encoding", "charset", "utf-8", "bom"],
  sections: [
    {
      items: [
        {
          t: "select",
          key: "editor.encodings.global",
          label: "Global Encoding",
          options: ENCODINGS,
          hint: "Decodes files outside the project that are not valid UTF-8.",
        },
        {
          t: "select",
          key: "editor.encodings.project",
          label: "Project Encoding",
          options: ENCODINGS,
          hint: "Encoding of new files; decodes project files that are not valid UTF-8 and have no BOM.",
        },
      ],
    },
    {
      title: "Properties Files (*.properties)",
      items: [
        {
          t: "select",
          key: "editor.encodings.properties",
          label: "Default encoding for properties files",
          options: ENCODINGS,
        },
      ],
    },
    {
      items: [
        {
          t: "select",
          key: "editor.encodings.utf8Bom",
          label: "Create UTF-8 files",
          options: [
            { value: "never", label: "with NO BOM" },
            { value: "always", label: "with BOM" },
            { value: "windows", label: "with BOM under Windows, with no BOM otherwise" },
          ],
        },
        {
          t: "note",
          text: "A charset in .editorconfig takes precedence. Change one file's encoding from the status bar.",
        },
      ],
    },
  ],
});

export const CODE_STYLE_PAGES = [CODE_STYLE, OTHER, ENCODINGS_PAGE];
