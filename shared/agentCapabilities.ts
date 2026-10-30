export interface AgentCapabilities {
  toolMode: 'parallel' | 'sequential';
  maxParallel: number;
  skillIds: string[];
  mcpIds: string[];
  pluginIds: string[];
  browserProfile: string;
}
export const defaultAgentCapabilities = (): AgentCapabilities => ({
  toolMode: 'parallel',
  maxParallel: 3,
  skillIds: [],
  mcpIds: [],
  pluginIds: [],
  browserProfile: '',
});
export interface CapabilityItem {
  id: string;
  name: string;
  description: string;
  builtin?: boolean;
  source?: string;
}
export interface McpItem extends CapabilityItem {
  url: string;
  hasToken: boolean;
}
export interface CapabilityCatalog {
  skills: CapabilityItem[];
  mcps: McpItem[];
  plugins: Array<
    CapabilityItem & {
      skillIds: string[];
      mcpIds: string[];
    }
  >;
  browser: {
    connected: boolean;
    configured: boolean;
    checkedAt?: string;
    error?: string;
    name: 'Ant-Browser';
  };
}
