/**
 * "Eclipse (macOS)" keymap: IntelliJ's macOS keymap with Eclipse's default
 * shortcuts on top (⌘⇧T / ⌘⇧R, F3, ⌘1, ⌘D, ⌥⌘R, F5–F8…). Actions Eclipse
 * doesn't bind keep their IntelliJ shortcuts. Overriding an id keeps its
 * position in `intellijMacos`, so the "later action wins a shared key" order
 * of the base keymap still holds; IntelliJ keys that would steal an Eclipse
 * key from a globally enabled action are moved or cleared here.
 */
import { intellijMacos } from "./intellij-macos";

export const eclipseMacos: Record<string, string[]> = {
  ...intellijMacos,
  // Navigate
  "navigate.gotoClass": ["Meta+Shift+T"],
  "navigate.gotoTest": [],
  "navigate.gotoFile": ["Meta+Shift+R"],
  "navigate.fileStructure": ["Meta+O", "Meta+F12"],
  "navigate.declaration": ["F3", "Meta+B"],
  "navigate.toggleBookmark": ["Ctrl+F3"],
  "navigate.typeHierarchy": ["Meta+T", "F4"],
  "navigate.typeDeclaration": ["Ctrl+Shift+B"],
  "navigate.lastEditLocation": ["Ctrl+Q", "Meta+Shift+Backspace"],
  "navigate.switcher": ["Ctrl+Tab", "Meta+F6"],
  "navigate.nextError": ["Meta+.", "F2"],
  "code.foldSelection": [],
  "navigate.nextOccurrence": [],
  "editor.matchBrace": ["Meta+Shift+P", "Ctrl+M"],
  "toolwindow.project": ["Meta+Alt+1"],
  // Find
  "find.inPath": ["Ctrl+H"],
  "find.replaceInPath": [],
  "find.usages": ["Meta+Shift+G", "Alt+F7"],
  "find.highlightUsages": ["Meta+Shift+U"],
  "find.next": ["Meta+K", "Meta+G"],
  "find.previous": ["Meta+Shift+K"],
  // Code
  "code.showIntentions": ["Meta+1", "Alt+Enter"],
  "code.parameterInfo": ["Meta+Shift+Space", "Meta+P"],
  "code.deleteLine": ["Meta+D"],
  "code.duplicateLine": ["Meta+Alt+Down"],
  "code.moveLineUp": ["Alt+Up"],
  "code.moveLineDown": ["Alt+Down"],
  "code.extendSelection": ["Alt+Shift+Up"],
  "code.shrinkSelection": ["Alt+Shift+Down"],
  "code.reformat": ["Meta+Shift+F"],
  "project.reformatCode": ["Meta+Shift+F"],
  "code.optimizeImports": ["Meta+Shift+O"],
  "project.optimizeImports": ["Meta+Shift+O"],
  "code.startNewLineBefore": ["Meta+Shift+Enter"],
  "code.completeStatement": [],
  "code.toggleCase": ["Meta+Shift+X", "Meta+Shift+Y"],
  "code.generate": ["Meta+Alt+S", "Meta+N"],
  "code.surroundWith": ["Alt+Shift+Z"],
  // Refactor
  "refactor.thisMenu": ["Meta+Alt+T"],
  "refactor.rename": ["Meta+Alt+R", "Shift+F6"],
  "project.rename": ["Meta+Alt+R", "Shift+F6"],
  "refactor.extractVariable": ["Meta+Alt+L"],
  "refactor.inline": ["Meta+Alt+I"],
  "refactor.move": ["Meta+Alt+V"],
  "project.move": ["Meta+Alt+V"],
  "refactor.changeSignature": ["Meta+Alt+C"],
  "refactor.extractConstant": [],
  // Run / debug
  "run.run": ["Meta+Shift+F11", "Ctrl+R"],
  "run.debug": ["Meta+F11", "Ctrl+D"],
  "debug.stepInto": ["F5"],
  "debug.stepOver": ["F6"],
  "debug.stepOut": ["F7"],
  "debug.resume": ["F8"],
  "debug.toggleBreakpoint": ["Meta+Shift+B"],
  "debug.evaluate": ["Meta+Shift+I", "Alt+F8"],
  // Moved off Eclipse keys (⌥⌘I Inline, ⌘K Find Next, ⌘T Type Hierarchy)
  "agents.newTask": ["Meta+Alt+Shift+I"],
  "vcs.commit": ["Ctrl+Alt+K"],
  "vcs.push": ["Meta+Alt+Shift+K"],
  "vcs.update": ["Ctrl+Alt+U"],
};
