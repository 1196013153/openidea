/** Settings › Editor pages (General and sub-pages, Code Editing, Font, Color Scheme, Code Style, File Encodings, Inlay Hints). */
import type { PageSpec } from "../spec";
import { GENERAL_PAGES } from "./general";
import { FONT_PAGE } from "./font";
import { COLOR_SCHEME_PAGE } from "./colorScheme";
import { CODE_STYLE_PAGES } from "./codeStyle";

export { codeStyleLanguagePages } from "./codeStyle";

export const EDITOR_PAGES: PageSpec[] = [...GENERAL_PAGES, FONT_PAGE, COLOR_SCHEME_PAGE, ...CODE_STYLE_PAGES];
