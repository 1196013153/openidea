/**
 * The IDEA-style shell (Islands): title bar, tool window stripes and island
 * panels around the editor area on the frame background, status bar, and the
 * overlay layer. Without an open project the
 * welcome view replaces the frame.
 */
import { useProject } from "@/platform/project";
import { useDistractionFree } from "./distractionFree";
import { EditorArea } from "./EditorArea";
import { OverlayHost } from "./OverlayHost";
import { projectColorVars } from "./projectColor";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { useApplyTheme } from "./theme";
import { ToolWindowLayout } from "./toolwindows/ToolWindows";
import { Welcome } from "./Welcome";
import styles from "./Workbench.module.css";

export function Workbench() {
  useApplyTheme();
  const project = useProject((s) => s.project);
  const root = project?.root ?? null;
  const distractionFree = useDistractionFree((s) => s.active);

  return (
    <div
      className={project ? `${styles.workbench} ${styles.framed}` : styles.workbench}
      style={project ? projectColorVars(project.name) : undefined}
    >
      {project ? (
        <>
          {/* Distraction Free Mode keeps the bar for the traffic lights and window dragging only. */}
          <TitleBar bare={distractionFree} />
          <ToolWindowLayout key={root} editor={<EditorArea />} />
          {!distractionFree && <StatusBar />}
        </>
      ) : (
        <Welcome />
      )}
      <OverlayHost />
    </div>
  );
}
