/**
 * Tools pages: Terminal, Actions on Save and External Tools. Consumed by the
 * terminal feature, the editor save participants and the run feature
 * (External Tools actions).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { commands, isTauri } from "@/platform/ipc";
import {
  DEFAULT_EXTERNAL_TOOL,
  EXTERNAL_TOOL_MACROS,
  WORKFLOW_LIMITS,
  type ExternalToolValid,
} from "@/platform/workflowSettings";
import { Button, Checkbox, IconButton, Input, Menu, type SelectOption, T } from "@/ui";
import { NumberInput, Row, SearchLabel, Section, Select } from "../components/Form";
import { useLabelMatch, useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { BoundToggle, Grid, Indented, PageLink, TableEditor } from "./workflowControls";
import styles from "./Workflow.module.css";

export const TOOLS_GROUP = "Tools";

const L = WORKFLOW_LIMITS;
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

// ---------------------------------------------------------------------------
// Terminal

function TextSetting({
  k,
  label,
  placeholder,
  hint,
  width = "wide",
  mono,
}: {
  k: string;
  label: string;
  placeholder?: string;
  hint?: ReactNode;
  width?: "wide" | "medium";
  mono?: boolean;
}) {
  const [value, set] = useSetting<string>(k);
  const id = useId();
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        mono={mono}
        className={styles[width]}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Row>
  );
}

function StartDirectoryRow() {
  return (
    <TextSetting
      k="terminal.startDirectory"
      label="Start directory"
      placeholder="Project root"
      mono
      hint="Relative paths resolve against the project root. “Open in Terminal” still opens the chosen folder."
    />
  );
}

const ENV_COLUMNS = [
  { key: "name", title: "Name", placeholder: "NAME", mono: true },
  { key: "value", title: "Value", placeholder: "value", mono: true },
];

function EnvRow() {
  const [env, setEnv] = useSetting<Record<string, string>>("terminal.env");
  return (
    <Row label="Environment variables" stacked hint="Added to the environment of new terminal sessions.">
      <TableEditor
        rows={Object.entries(env).map(([name, value]) => ({ name, value }))}
        columns={ENV_COLUMNS}
        onChange={(rows) => setEnv(Object.fromEntries(rows.map((r) => [r.name ?? "", r.value ?? ""])))}
        empty="No variables"
        aria-label="Environment variables"
      />
    </Row>
  );
}

function ShellPathRow() {
  const [detected, setDetected] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void commands.termDefaultShell().then(setDetected, () => undefined);
  }, []);
  return (
    <TextSetting
      k="terminal.shellPath"
      label="Shell path"
      mono
      placeholder={detected ?? "Login shell"}
      hint="A command line, e.g. /bin/zsh --login. Leave empty to use the login shell."
    />
  );
}

const CURSOR_SHAPES: SelectOption[] = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Vertical" },
];

function CursorRow() {
  const [shape, setShape] = useSetting<string>("terminal.cursorShape");
  const [blink, setBlink] = useSetting<boolean>("terminal.cursorBlink");
  const matched = useLabelMatch("Blinking cursor");
  return (
    <Row label="Cursor shape">
      <Select value={shape} options={CURSOR_SHAPES} onChange={setShape} aria-label="Cursor shape" />
      <span className={clsx(styles.inlineRow, matched && styles.matched)}>
        <Checkbox checked={blink} onChange={setBlink} label={<SearchLabel text="Blinking cursor" />} />
      </span>
    </Row>
  );
}

function TerminalOptions() {
  return (
    <Grid
      left={
        <>
          <BoundToggle k="terminal.audibleBell" label="Audible bell" />
          <BoundToggle k="terminal.closeOnExit" label="Close session when it ends" />
          <BoundToggle k="terminal.mouseReporting" label="Mouse reporting" />
          <BoundToggle k="terminal.copyOnSelection" label="Copy to clipboard on selection" />
          <BoundToggle k="terminal.pasteOnMiddleClick" label="Paste on middle mouse button click" />
        </>
      }
      right={
        <>
          <BoundToggle k="terminal.overrideIdeShortcuts" label="Override IDE shortcuts" />
          <BoundToggle k="terminal.shellIntegration" label="Shell integration" />
          <BoundToggle k="terminal.highlightHyperlinks" label="Highlight hyperlinks" />
          {isMac && <BoundToggle k="terminal.optionAsMeta" label="Use Option as Meta key" />}
        </>
      }
    />
  );
}

function TerminalFont() {
  const [useEditor, setUseEditor] = useSetting<boolean>("terminal.useEditorFont");
  const [family, setFamily] = useSetting<string>("terminal.fontFamily");
  const [size, setSize] = useSetting<number>("terminal.fontSize");
  const [lineHeight, setLineHeight] = useSetting<number>("terminal.lineHeight");
  const matched = useLabelMatch("Use editor font");
  const familyId = useId();
  return (
    <>
      <div className={clsx(styles.inlineRow, matched && styles.matched)}>
        <Checkbox checked={useEditor} onChange={setUseEditor} label={<SearchLabel text="Use editor font" />} />
        <span className={styles.note}>
          <T>configured in</T>{" "}
          <PageLink page="editor.font">
            <T>Editor › Font</T>
          </PageLink>
        </span>
      </div>
      <Indented>
        <Row label="Font" htmlFor={familyId}>
          <Input
            id={familyId}
            className={styles.medium}
            disabled={useEditor}
            value={family}
            onChange={(e) => e.target.value.trim() && setFamily(e.target.value)}
          />
        </Row>
        <Row label="Size">
          <NumberInput
            value={size}
            onChange={setSize}
            {...L.terminalFontSize}
            step={1}
            unit="px"
            aria-label="Terminal font size"
          />
        </Row>
        <Row label="Line height">
          <NumberInput
            value={lineHeight}
            onChange={setLineHeight}
            {...L.terminalLineHeight}
            step={0.1}
            aria-label="Terminal line height"
          />
        </Row>
      </Indented>
    </>
  );
}

// ---------------------------------------------------------------------------
// Actions on Save

function ActionsOnSave() {
  return (
    <>
      <BoundToggle
        k="editor.formatOnSave"
        label="Reformat code"
        hint="Formats the whole file with the language server's formatter."
      />
      <BoundToggle
        k="actionsOnSave.optimizeImports"
        label="Optimize imports"
        hint="Runs the language server's Organize Imports action."
      />
      <BoundToggle
        k="actionsOnSave.cleanup"
        label="Run code cleanup"
        hint="Applies the language server's fix-all action (source.fixAll)."
      />
    </>
  );
}

function ActionsOnSaveNote() {
  return (
    <div className={styles.note}>
      <T>
        {
          "Actions run when a file is saved with Save (⌘S) or Save All. Trailing spaces and the final line break are configured in"
        }
      </T>{" "}
      <PageLink page="editor.general">
        <T>Editor › General</T>
      </PageLink>
      .
    </div>
  );
}

// ---------------------------------------------------------------------------
// External Tools

function MacroButton({ onInsert }: { onInsert: (macro: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={ref} size="small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <T>Insert Macro…</T>
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="bottom-end"
        aria-label="Macros"
        items={EXTERNAL_TOOL_MACROS.map((m) => ({
          id: m.name,
          label: m.name,
          shortcut: m.description,
          run: () => onInsert(m.name),
        }))}
      />
    </>
  );
}

function ToolField({
  label,
  value,
  onChange,
  macros,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  macros?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id} className={styles.alignedRow}>
      <span className={styles.macroField}>
        <Input
          id={id}
          mono={macros}
          className={styles.wide}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {macros && (
          <MacroButton onInsert={(m) => onChange(value ? `${value}${value.endsWith(" ") ? "" : " "}${m}` : m)} />
        )}
      </span>
    </Row>
  );
}

let toolSeq = 0;
const newToolId = () => `tool-${Date.now().toString(36)}-${++toolSeq}`;

function ExternalToolsEditor() {
  const [tools, setTools] = useSetting<ExternalToolValid[]>("externalTools");
  const [selected, setSelected] = useState<string | null>(tools[0]?.id ?? null);
  const current = tools.find((t) => t.id === selected) ?? null;
  const index = current ? tools.indexOf(current) : -1;

  const update = (patch: Partial<ExternalToolValid>) => {
    if (!current) return;
    setTools(tools.map((t) => (t.id === current.id ? { ...t, ...patch } : t)));
  };
  const add = (base?: ExternalToolValid) => {
    const tool: ExternalToolValid = base
      ? { ...base, id: newToolId(), name: `${base.name} (copy)` }
      : { ...DEFAULT_EXTERNAL_TOOL, id: newToolId(), name: `Tool ${tools.length + 1}` };
    setTools([...tools, tool]);
    setSelected(tool.id);
  };
  const remove = () => {
    if (!current) return;
    const rest = tools.filter((t) => t.id !== current.id);
    setTools(rest);
    setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };
  const move = (d: -1 | 1) => {
    const j = index + d;
    if (index < 0 || j < 0 || j >= tools.length) return;
    const next = [...tools];
    [next[index], next[j]] = [next[j]!, next[index]!];
    setTools(next);
  };

  return (
    <div className={styles.toolsLayout}>
      <div className={styles.tableBox}>
        <div className={styles.toolbar} role="toolbar" aria-label="External tools actions">
          <IconButton icon="plus" title="Add" size="small" onClick={() => add()} />
          <IconButton icon="minus" title="Remove" size="small" disabled={!current} onClick={remove} />
          <IconButton
            icon="copy"
            title="Copy"
            size="small"
            disabled={!current}
            onClick={() => current && add(current)}
          />
          <IconButton icon="arrow-up" title="Move Up" size="small" disabled={index <= 0} onClick={() => move(-1)} />
          <IconButton
            icon="arrow-down"
            title="Move Down"
            size="small"
            disabled={index < 0 || index >= tools.length - 1}
            onClick={() => move(1)}
          />
        </div>
        <div className={styles.toolList} role="listbox" aria-label="External tools">
          {tools.length === 0 && (
            <div className={clsx(styles.toolRow, styles.empty)}>
              <T>No external tools. Click + to add one.</T>
            </div>
          )}
          {tools.map((t) => (
            <div
              key={t.id}
              role="option"
              aria-selected={t.id === selected}
              className={clsx(styles.toolRow, t.id === selected && styles.toolRowSelected)}
              onMouseDown={() => setSelected(t.id)}
            >
              <Checkbox
                aria-label={`Enable ${t.name}`}
                checked={t.enabled}
                onChange={(on) => setTools(tools.map((x) => (x.id === t.id ? { ...x, enabled: on } : x)))}
              />
              <span>{t.name}</span>
              <span className={styles.toolGroup}>{t.group}</span>
            </div>
          ))}
        </div>
      </div>
      {current && (
        <Section title="Tool Settings">
          <ToolField label="Name" value={current.name} onChange={(name) => update({ name })} />
          <ToolField
            label="Group"
            value={current.group}
            onChange={(group) => update({ group })}
            placeholder="External Tools"
          />
          <ToolField
            label="Description"
            value={current.description}
            onChange={(description) => update({ description })}
          />
          <ToolField
            label="Program"
            value={current.program}
            onChange={(program) => update({ program })}
            macros
            placeholder="e.g. /usr/bin/env"
          />
          <ToolField
            label="Arguments"
            value={current.arguments}
            onChange={(args) => update({ arguments: args })}
            macros
          />
          <ToolField
            label="Working directory"
            value={current.workingDirectory}
            onChange={(workingDirectory) => update({ workingDirectory })}
            macros
            placeholder="$ProjectFileDir$"
          />
          <Checkbox
            checked={current.synchronizeAfter}
            onChange={(synchronizeAfter) => update({ synchronizeAfter })}
            label="Synchronize files after execution"
          />
          <Checkbox
            checked={current.openConsole}
            onChange={(openConsole) => update({ openConsole })}
            label="Open console for tool output"
          />
        </Section>
      )}
      <div className={styles.note}>
        <T>
          {
            "Enabled tools appear in Find Action (⇧⌘A) under “External Tools” and can get shortcuts in Keymap. Output is shown in the Run tool window."
          }
        </T>
      </div>
    </div>
  );
}

export const TOOLS_PAGES: PageSpec[] = [
  {
    id: "tools.terminal",
    title: "Terminal",
    group: TOOLS_GROUP,
    order: 600,
    projectScope: true,
    keywords: ["shell", "console", "zsh", "bash", "pty"],
    sections: [
      {
        title: "Project Settings",
        options: [
          { kind: "custom", label: "Start directory", component: StartDirectoryRow },
          { kind: "custom", label: "Environment variables", keywords: ["env"], component: EnvRow },
        ],
      },
      {
        title: "Application Settings",
        options: [
          { kind: "custom", label: "Shell path", component: ShellPathRow },
          { kind: "text", key: "terminal.tabName", label: "Default Tab name", placeholder: "Local" },
          {
            kind: "custom",
            label: "Audible bell",
            keywords: [
              "Close session when it ends",
              "Mouse reporting",
              "Copy to clipboard on selection",
              "Paste on middle mouse button click",
              "Override IDE shortcuts",
              "Shell integration",
              "Highlight hyperlinks",
              "Use Option as Meta key",
            ],
            component: TerminalOptions,
          },
          {
            kind: "custom",
            label: "Cursor shape",
            keywords: ["Block", "Underline", "Vertical", "Blinking cursor"],
            component: CursorRow,
          },
        ],
      },
      {
        title: "Font",
        options: [
          {
            kind: "custom",
            label: "Use editor font",
            keywords: ["Font", "Size", "Line height"],
            component: TerminalFont,
          },
        ],
      },
    ],
  },
  {
    id: "tools.actionsOnSave",
    title: "Actions on Save",
    group: TOOLS_GROUP,
    order: 601,
    projectScope: true,
    keywords: ["save", "format on save", "reformat", "organize imports", "cleanup"],
    sections: [
      {
        title: "Activate on Save",
        options: [
          {
            kind: "custom",
            label: "Reformat code",
            keywords: ["Optimize imports", "Run code cleanup"],
            component: ActionsOnSave,
          },
        ],
      },
      { options: [{ kind: "custom", label: "Save", component: ActionsOnSaveNote }] },
    ],
  },
  {
    id: "tools.externalTools",
    title: "External Tools",
    group: TOOLS_GROUP,
    order: 602,
    keywords: ["program", "arguments", "macro", "working directory", "command"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "External Tools",
            keywords: [
              "Program",
              "Arguments",
              "Working directory",
              "Insert Macro",
              "Synchronize files after execution",
            ],
            component: ExternalToolsEditor,
          },
        ],
      },
    ],
  },
];
