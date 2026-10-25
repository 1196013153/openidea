import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TodoView, useTodoView, useTodoViewOptions } from "./TodoView";
import { useTodos } from "./store";

describe("TodoView", () => {
  it("renders grouped items with the keyword emphasised and filters by keyword", () => {
    act(() =>
      useTodos.setState({
        scannedOnce: true,
        scanned: new Map([
          [
            "/p/src/a.ts",
            [
              { path: "/p/src/a.ts", line: 4, col: 3, keyword: "TODO", text: "TODO: wire it" },
              { path: "/p/src/a.ts", line: 9, col: 3, keyword: "FIXME", text: "FIXME broken" },
            ],
          ],
        ]),
      }),
    );
    render(<TodoView />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("(5, 4)")).toBeInTheDocument();
    expect(screen.getByText(": wire it")).toBeInTheDocument();
    act(() => useTodoView.getState().toggleKeyword("FIXME"));
    expect(screen.getByText("1 item")).toBeInTheDocument();
    act(() => useTodoView.getState().showAll());
  });

  it("shows the preview pane and does not autoscroll by default, as IDEA", () => {
    expect(useTodoViewOptions.getState()).toEqual({ preview: true, autoscroll: false });
    render(<TodoView />);
    expect(screen.getByText("Select an item to preview")).toBeInTheDocument();
    act(() => useTodoViewOptions.setState({ preview: false }));
    expect(screen.queryByText("Select an item to preview")).toBeNull();
    act(() => useTodoViewOptions.setState({ preview: true }));
  });
});
