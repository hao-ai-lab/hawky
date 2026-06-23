import { create } from "zustand";

interface WebSettingsState {
  agentRuntimesEnabled: boolean;
  setAgentRuntimesEnabled: (enabled: boolean) => void;
}

export const useWebSettingsStore = create<WebSettingsState>((set) => ({
  agentRuntimesEnabled: false,
  setAgentRuntimesEnabled: (enabled) => set({ agentRuntimesEnabled: enabled }),
}));
