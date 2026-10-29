/**
 * "Eclipse (Windows)" keymap: IntelliJ's Windows keymap with Eclipse's default
 * Windows / Linux shortcuts on top (Ctrl+Shift+T / R, F3, Ctrl+1, Ctrl+D,
 * Alt+Shift+R, F5–F8…). Actions Eclipse doesn't bind keep their IntelliJ
 * shortcuts. Overriding an id keeps its position in `intellijWindows`, so the
 * "later action wins a shared key" order still holds; IntelliJ keys that would
 * steal an Eclipse key from a globally enabled or editor action are moved or
 * cleared here.
 */
import { intellijWindows } from "./intellij-windows";

export const eclipseWindows: Record<string, string[]> = {
  ...intellijWindows,
  // Navigate
  "navigate.gotoClass": ["Ctrl+Shift+T"],
  "navigate.gotoTest": [],
  "navigate.gotoFile": ["Ctrl+Shift+R"],
  "navigate.fileStructure": ["Ctrl+O", "Ctrl+F12"],
  "navigate.declaration": ["F3", "Ctrl+B"],
  // F11 / Ctrl+F11 are Debug / Run.
  "navigate.toggleBookmark": ["Ctrl+F3"],
  "navigate.toggleBookmarkWithMnemonic": ["Ctrl+Shift+F3"],
  "navigate.typeHierarchy": ["Ctrl+T", "F4"],
  // Ctrl+Shift+B is Toggle Breakpoint.
  "navigate.typeDeclaration": [],
  "navigate.lastEditLocation": ["Ctrl+Q", "Ctrl+Shift+Backspace"],
  "navigate.switcher": ["Ctrl+Tab", "Ctrl+F6"],
  "navigate.nextError": ["Ctrl+.", "F2"],
  "code.foldSelection": [],
  // Alt+Up / Down move lines; Eclipse's Next / Previous Member.
  "navigate.nextMethod": ["Ctrl+Shift+Down"],
  "navigate.previousMethod": ["Ctrl+Shift+Up"],
  "code.moveStatementUp": [],
  "code.moveStatementDown": [],
  "navigate.nextOccurrence": [],
  "editor.matchBrace": ["Ctrl+Shift+P", "Ctrl+Shift+M"],
  "code.expressionTypeInfo": [],
  // Find
  "find.inPath": ["Ctrl+H"],
  "find.replaceInPath": [],
  "find.usages": ["Ctrl+Shift+G", "Alt+F7"],
  "find.highlightUsages": ["Ctrl+Shift+U"],
  "find.next": ["Ctrl+K", "Ctrl+L"],
  "find.previous": ["Ctrl+Shift+K", "Ctrl+Shift+L"],
  // Code
  // Ctrl+Q is Last Edit Location.
  "code.quickDocumentation": ["F1"],
  "code.showIntentions": ["Ctrl+1", "Alt+Enter"],
  "code.parameterInfo": ["Ctrl+Shift+Space", "Ctrl+P"],
  // Ctrl+Y stays Redo.
  "code.deleteLine": ["Ctrl+D"],
  "code.duplicateLine": ["Ctrl+Alt+Down"],
  "code.moveLineUp": ["Alt+Up"],
  "code.moveLineDown": ["Alt+Down"],
  "code.extendSelection": ["Alt+Shift+Up"],
  "code.shrinkSelection": ["Alt+Shift+Down"],
  "code.reformat": ["Ctrl+Shift+F"],
  "project.reformatCode": ["Ctrl+Shift+F"],
  "code.optimizeImports": ["Ctrl+Shift+O"],
  "project.optimizeImports": ["Ctrl+Shift+O"],
  "code.startNewLineBefore": ["Ctrl+Shift+Enter"],
  "code.completeStatement": [],
  "code.toggleCase": ["Ctrl+Shift+X", "Ctrl+Shift+Y"],
  // Ctrl+O is Quick Outline; Override Methods is in Source (Alt+Shift+S).
  "code.overrideMethods": [],
  "code.generate": ["Alt+Shift+S", "Alt+Insert"],
  "code.surroundWith": ["Alt+Shift+Z"],
  // Refactor
  "refactor.thisMenu": ["Alt+Shift+T"],
  "refactor.rename": ["Alt+Shift+R", "Shift+F6"],
  "project.rename": ["Alt+Shift+R", "Shift+F6"],
  "refactor.extractVariable": ["Alt+Shift+L"],
  "refactor.extractMethod": ["Alt+Shift+M"],
  "refactor.inline": ["Alt+Shift+I"],
  "refactor.move": ["Alt+Shift+V"],
  "project.move": ["Alt+Shift+V"],
  "refactor.changeSignature": ["Alt+Shift+C"],
  // Alt+Shift+C is Change Signature.
  "localHistory.recentChanges": [],
  // Run / debug
  "run.run": ["Ctrl+F11", "Shift+F10"],
  "run.debug": ["F11", "Shift+F9"],
  "debug.stepInto": ["F5"],
  "debug.stepOver": ["F6"],
  "debug.stepOut": ["F7"],
  "debug.resume": ["F8"],
  "debug.toggleBreakpoint": ["Ctrl+Shift+B"],
  "debug.evaluate": ["Ctrl+Shift+I", "Alt+F8"],
  // Moved off Eclipse keys (Ctrl+K / Ctrl+Shift+K Find Next / Previous, Ctrl+T Type Hierarchy)
  "vcs.commit": ["Alt+Shift+K"],
  "vcs.push": ["Ctrl+Alt+Shift+K"],
  "vcs.update": ["Ctrl+Alt+U"],
};
