import { Component, type ComponentType, type ReactNode } from "react";

interface Props {
  /** Shown in logs to identify the failing contribution. */
  name: string;
  children: ReactNode;
  fallback?: ReactNode;
}

/** Isolates contributed UI so one failing feature can't take down the shell. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[workbench] ${this.props.name} crashed`, error);
  }

  render() {
    if (this.state.error) return this.props.fallback ?? null;
    return this.props.children;
  }
}

/** Renders a component supplied through a slot or contribution. */
export function Slot({ component: C }: { component: ComponentType }) {
  return <C />;
}
