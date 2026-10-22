import { create } from "zustand";
import { loadJson, saveJson } from "../storage";
import { BUILTIN_FILE_TEMPLATES } from "./builtins";
import type { FileTemplate } from "./model";

export const FILE_TEMPLATES_KEY = "openidea.fileTemplates.v1";
const KEY = FILE_TEMPLATES_KEY;
const BUILTIN_IDS = new Set(BUILTIN_FILE_TEMPLATES.map((t) => t.id));

interface Customizations {
  templates: Record<string, FileTemplate>;
  deleted: string[];
}

export function mergeFileTemplates(c: Customizations): FileTemplate[] {
  const deleted = new Set(c.deleted);
  const out = BUILTIN_FILE_TEMPLATES.filter((t) => !deleted.has(t.id)).map((t) => c.templates[t.id] ?? t);
  for (const t of Object.values(c.templates)) if (!BUILTIN_IDS.has(t.id) && !deleted.has(t.id)) out.push(t);
  return out;
}

const initial = loadJson<Customizations>(KEY, { templates: {}, deleted: [] });

export const useFileTemplates = create<{ custom: Customizations; templates: FileTemplate[] }>(() => ({
  custom: initial,
  templates: mergeFileTemplates(initial),
}));

function commit(custom: Customizations) {
  saveJson(KEY, custom);
  useFileTemplates.setState({ custom, templates: mergeFileTemplates(custom) });
}

export const fileTemplates = () => useFileTemplates.getState().templates;
export const isBuiltinFileTemplate = (id: string) => BUILTIN_IDS.has(id);

export function saveFileTemplate(t: FileTemplate) {
  const c = useFileTemplates.getState().custom;
  commit({ templates: { ...c.templates, [t.id]: t }, deleted: c.deleted.filter((d) => d !== t.id) });
}

export function removeFileTemplate(id: string) {
  const c = useFileTemplates.getState().custom;
  const templates = { ...c.templates };
  delete templates[id];
  commit({ templates, deleted: BUILTIN_IDS.has(id) ? [...new Set([...c.deleted, id])] : c.deleted });
}

export function resetFileTemplate(id: string) {
  const c = useFileTemplates.getState().custom;
  const templates = { ...c.templates };
  delete templates[id];
  commit({ templates, deleted: c.deleted.filter((d) => d !== id) });
}

export function isModifiedFileTemplate(id: string): boolean {
  return BUILTIN_IDS.has(id) && id in useFileTemplates.getState().custom.templates;
}

/** Re-reads customisations (changed by another window). */
export function reloadFileTemplates() {
  const custom = loadJson<Customizations>(KEY, { templates: {}, deleted: [] });
  useFileTemplates.setState({ custom, templates: mergeFileTemplates(custom) });
}
