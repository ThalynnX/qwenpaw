import { useCallback, useEffect, useRef, useState } from "react";
import { useAppMessage } from "../../../hooks/useAppMessage";
import api from "../../../api";
import type { MCPAccessPolicy, MCPClientInfo } from "../../../api/types";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "../../../stores/agentStore";
import {
  harnessApi,
  type HarnessDiscoveredMCPServer,
} from "../../../api/modules/harness";

export function useMCP() {
  const { t } = useTranslation();
  const { selectedAgent, agents } = useAgentStore();
  const selectedAgentInfo = agents.find((item) => item.id === selectedAgent);
  const selectedBackend = selectedAgentInfo?.backend ?? "qwenpaw";
  const canDiscoverProviderMCP = Boolean(
    selectedAgentInfo?.backend_capabilities?.provider_mcp_discovery,
  );
  const [clients, setClients] = useState<MCPClientInfo[]>([]);
  const [providerServers, setProviderServers] = useState<
    HarnessDiscoveredMCPServer[]
  >([]);
  const [loadingAgent, setLoadingAgent] = useState<string | null>(null);
  const [loadedAgent, setLoadedAgent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{
    agentId: string;
    message: string;
  } | null>(null);
  const { message } = useAppMessage();
  const requestGeneration = useRef(0);
  const loadedAgentRef = useRef<string | null>(null);
  const agentId = selectedAgent || "default";

  const canMutate = useCallback(
    () =>
      loadedAgentRef.current === agentId &&
      (useAgentStore.getState().selectedAgent || "default") === agentId,
    [agentId],
  );

  const loadClients = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const requestedAgent = selectedAgent || "default";
    const isCurrentRequest = () =>
      generation === requestGeneration.current &&
      (useAgentStore.getState().selectedAgent || "default") === requestedAgent;

    if (!isCurrentRequest()) return;
    setLoadingAgent(requestedAgent);
    setLoadError(null);
    try {
      const data = await api.listMCPClients(requestedAgent);
      let discoveredServers: HarnessDiscoveredMCPServer[] = [];
      let discoveryWarning = "";
      if (selectedBackend !== "qwenpaw" && canDiscoverProviderMCP) {
        try {
          const discovered = await harnessApi.listMCP(selectedBackend);
          discoveredServers = discovered.servers;
          discoveryWarning = discovered.message ?? "";
        } catch (error) {
          console.warn("Failed to discover Provider MCP servers:", error);
        }
      }
      if (!isCurrentRequest()) return;
      setClients(data);
      setProviderServers(discoveredServers);
      loadedAgentRef.current = requestedAgent;
      setLoadedAgent(requestedAgent);
      if (discoveryWarning) message.warning(discoveryWarning);
    } catch (error) {
      if (!isCurrentRequest()) return;
      console.error("Failed to load MCP clients:", error);
      const errorMessage = t("mcp.loadError");
      setLoadError({ agentId: requestedAgent, message: errorMessage });
      message.error(errorMessage);
    } finally {
      if (isCurrentRequest()) setLoadingAgent(null);
    }
  }, [canDiscoverProviderMCP, message, selectedAgent, selectedBackend, t]);

  useEffect(() => {
    void loadClients();
    return () => {
      requestGeneration.current += 1;
    };
  }, [loadClients]);

  const createClient = useCallback(
    async (
      key: string,
      clientData: {
        name: string;
        description?: string;
        command: string;
        enabled?: boolean;
        transport?: "stdio" | "streamable_http" | "sse";
        url?: string;
        headers?: Record<string, string>;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        http_timeout?: number;
      },
    ) => {
      if (!canMutate()) return false;
      try {
        await api.createMCPClient({
          client_key: key,
          client: clientData,
        });
        message.success(t("mcp.createSuccess"));
        await loadClients();
        return true;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : t("mcp.createError");
        message.error(errorMsg);
        return false;
      }
    },
    [canMutate, message, t, loadClients],
  );

  const updateClient = useCallback(
    async (
      key: string,
      updates: {
        name?: string;
        description?: string;
        command?: string;
        enabled?: boolean;
        transport?: "stdio" | "streamable_http" | "sse";
        url?: string;
        headers?: Record<string, string>;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        http_timeout?: number;
      },
    ) => {
      if (!canMutate()) return false;
      try {
        await api.updateMCPClient(key, updates);
        setClients((current) =>
          current.map((item) =>
            item.key === key ? { ...item, ...updates } : item,
          ),
        );
        return true;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : t("mcp.updateError");
        message.error(errorMsg);
        return false;
      }
    },
    [canMutate, message, t],
  );

  const toggleEnabled = useCallback(
    async (client: MCPClientInfo) => {
      if (!canMutate()) return;
      try {
        await api.toggleMCPClient(client.key);
        setClients((current) =>
          current.map((item) =>
            item.key === client.key
              ? { ...item, enabled: !client.enabled }
              : item,
          ),
        );
      } catch {
        message.error(t("mcp.toggleError"));
      }
    },
    [canMutate, message, t],
  );

  const deleteClient = useCallback(
    async (client: MCPClientInfo) => {
      if (!canMutate()) return;
      try {
        await api.deleteMCPClient(client.key);
        message.success(t("mcp.deleteSuccess"));
        await loadClients();
      } catch {
        message.error(t("mcp.deleteError"));
      }
    },
    [canMutate, message, t, loadClients],
  );

  const updatePolicy = useCallback(
    async (clientKey: string, policy: MCPAccessPolicy) => {
      if (!canMutate()) return false;
      try {
        await api.updateMCPPolicy(clientKey, policy);
        message.success(t("mcp.access.saveSuccess"));
        await loadClients();
        return true;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : t("mcp.access.saveError");
        message.error(errorMsg);
        return false;
      }
    },
    [canMutate, message, t, loadClients],
  );

  const ready = loadedAgent === agentId;
  const error = loadError?.agentId === agentId ? loadError.message : null;
  const loading = loadingAgent === agentId || (!ready && !error);

  return {
    clients,
    providerServers,
    loading,
    error,
    ready,
    createClient,
    updateClient,
    updatePolicy,
    toggleEnabled,
    deleteClient,
    refreshClients: loadClients,
  };
}
