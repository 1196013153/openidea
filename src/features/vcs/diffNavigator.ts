/** The focused diff editor's chunk navigation, for actions that must not load the diff editor. */

export interface DiffNavigator {
  next(): void;
  prev(): void;
  jumpToSource(): void;
}

let focused: DiffNavigator | null = null;

export function focusedDiffNavigator(): DiffNavigator | null {
  return focused;
}

export function setFocusedDiffNavigator(nav: DiffNavigator | null) {
  focused = nav;
}
