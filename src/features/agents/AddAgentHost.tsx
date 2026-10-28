/** Renders the Add Agent dialog while `agents.addAgent` has it open. */
import { lazyComponent } from "@/ui";
import { closeAddAgent, useAddAgent } from "./registry";
import { refreshProviders } from "./store";

const AddAgentDialog = lazyComponent(() => import("./AddAgentDialog").then((m) => m.AddAgentDialog));

export function AddAgentHost() {
  const open = useAddAgent((s) => s.open);
  return open ? <AddAgentDialog onClose={closeAddAgent} onChanged={() => void refreshProviders()} /> : null;
}
