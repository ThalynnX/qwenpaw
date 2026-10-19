import { useState, useEffect, useCallback, useRef } from "react";
import { Modal } from "@agentscope-ai/design";
import { useAppMessage } from "../../../hooks/useAppMessage";
import api from "../../../api";
import type { SecurityScanErrorResponse } from "../../../api/modules/security";
import { invalidateSkillCache } from "../../../api/modules/skill";
import type { SkillSpec } from "../../../api/types";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "../../../stores/agentStore";
import {
  harnessApi,
  type HarnessDiscoveredSkill,
} from "../../../api/modules/harness";
import { parseErrorDetail } from "../../../utils/error";
import {
  handleScanError,
  checkScanWarnings as checkScanWarningsShared,
  showScanErrorModal,
} from "../../../utils/scanError";
import { subscribeToSkillChanges } from "../../../utils/skillChangeEvents";

type SkillActionResult =
  | { success: true; name?: string; imported?: string[] }
  | {
      success: false;
      conflict?: {
        suggested_name?: string;
        skill_name?: string;
        conflicts?: { suggested_name?: string; skill_name?: string }[];
      };
    };

function currentAgentId() {
  return useAgentStore.getState().selectedAgent || "default";
}

export function useSkills() {
  const { t } = useTranslation();
  const { selectedAgent, agents } = useAgentStore();
  const selectedAgentInfo = agents.find((item) => item.id === selectedAgent);
  const selectedBackend = selectedAgentInfo?.backend ?? "qwenpaw";
  const canDiscoverProviderSkills = Boolean(
    selectedAgentInfo?.backend_capabilities?.provider_skills_discovery,
  );
  const [skills, setSkills] = useState<SkillSpec[]>([]);
  const [providerSkills, setProviderSkills] = useState<
    HarnessDiscoveredSkill[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{
    agentId: string;
    value: unknown;
  } | null>(null);
  const [loadedAgent, setLoadedAgent] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const importTaskIdRef = useRef<string | null>(null);
  const importCancelReasonRef = useRef<"manual" | "timeout" | null>(null);
  const requestGenerationRef = useRef(0);
  const loadedAgentRef = useRef<string | null>(null);
  const { message } = useAppMessage();

  const ownsCurrentAgent = useCallback(
    () =>
      loadedAgent !== null &&
      loadedAgentRef.current === loadedAgent &&
      currentAgentId() === loadedAgent,
    [loadedAgent],
  );

  const handleError = useCallback(
    (error: unknown, defaultMsg: string): boolean => {
      if (handleScanError(error, t)) return true;
      const msg =
        error instanceof Error && error.message ? error.message : defaultMsg;
      console.error(defaultMsg, error);
      message.error(msg);
      return false;
    },
    [message, t],
  );

  const checkScanWarnings = useCallback(
    (skillName: string) =>
      checkScanWarningsShared(
        skillName,
        api.getBlockedHistory,
        api.getSkillScanner,
        t,
      ),
    [t],
  );

  const loadSkillsForAgent = useCallback(
    async (
      requestedAgent: string,
      requestedBackend: string,
      discoverProviderSkills: boolean,
      hardRefresh = false,
    ) => {
      if (currentAgentId() !== requestedAgent) return;
      const generation = ++requestGenerationRef.current;
      const isCurrentRequest = () =>
        generation === requestGenerationRef.current &&
        currentAgentId() === requestedAgent;

      loadedAgentRef.current = null;
      setLoadedAgent(null);
      setLoading(true);
      setLoadError(null);
      setProviderSkills([]);
      try {
        if (hardRefresh) invalidateSkillCache({ agentId: requestedAgent });
        const data = hardRefresh
          ? await api.refreshSkills(requestedAgent)
          : await api.listSkills(requestedAgent);
        if (!isCurrentRequest()) return;

        let discoveredSkills: HarnessDiscoveredSkill[] = [];
        if (requestedBackend !== "qwenpaw" && discoverProviderSkills) {
          try {
            const result = await harnessApi.listSkills(requestedBackend);
            if (!isCurrentRequest()) return;
            discoveredSkills = result.skills;
            if (result.message) message.warning(result.message);
          } catch (providerError) {
            if (!isCurrentRequest()) return;
            console.warn("Failed to discover Provider Skills:", providerError);
          }
        }

        if (!isCurrentRequest()) return;
        setSkills(data || []);
        setProviderSkills(discoveredSkills);
        loadedAgentRef.current = requestedAgent;
        setLoadedAgent(requestedAgent);
      } catch (loadError) {
        if (!isCurrentRequest()) return;
        console.error(
          t(hardRefresh ? "skills.refreshFailed" : "skills.loadFailed"),
          loadError,
        );
        setLoadError({
          agentId: requestedAgent,
          value:
            loadError instanceof Error
              ? loadError
              : new Error(t("skills.loadFailed")),
        });
        message.error(
          t(hardRefresh ? "skills.refreshFailed" : "skills.loadFailed"),
        );
      } finally {
        if (isCurrentRequest()) setLoading(false);
      }
    },
    [message, t],
  );

  const fetchSkills = useCallback(
    () =>
      loadSkillsForAgent(
        selectedAgent || "default",
        selectedBackend,
        canDiscoverProviderSkills,
      ),
    [
      canDiscoverProviderSkills,
      loadSkillsForAgent,
      selectedAgent,
      selectedBackend,
    ],
  );

  const hardRefresh = useCallback(
    () =>
      loadSkillsForAgent(
        selectedAgent || "default",
        selectedBackend,
        canDiscoverProviderSkills,
        true,
      ),
    [
      canDiscoverProviderSkills,
      loadSkillsForAgent,
      selectedAgent,
      selectedBackend,
    ],
  );

  // Invalidate cache when agent changes
  useEffect(() => {
    invalidateSkillCache({ agentId: selectedAgent });
    void fetchSkills();
    return () => {
      requestGenerationRef.current += 1;
      loadedAgentRef.current = null;
    };
  }, [selectedAgent, fetchSkills]);

  useEffect(
    () =>
      subscribeToSkillChanges((change) => {
        if (change.agentId !== selectedAgent) return;
        invalidateSkillCache({ agentId: selectedAgent });
        void fetchSkills();
      }),
    [fetchSkills, selectedAgent],
  );

  const createSkill = async (
    name: string,
    content: string,
    config?: Record<string, unknown>,
    enable?: boolean,
  ): Promise<SkillActionResult> => {
    if (!ownsCurrentAgent()) {
      return { success: false };
    }
    try {
      const result = await api.createSkill(name, content, config, enable);
      message.success(t("skills.createdSuccessfully"));
      invalidateSkillCache({ agentId: selectedAgent }); // Clear cache after mutation
      await fetchSkills();
      await checkScanWarnings(result.name);
      return { success: true, name: result.name };
    } catch (error) {
      const detail = parseErrorDetail(error);
      if (detail?.suggested_name) {
        return { success: false, conflict: detail };
      }
      handleError(error, t("skills.saveFailed"));
      return { success: false };
    }
  };

  const uploadSkill = async (
    file: File,
    targetName?: string,
    renameMap?: Record<string, string>,
  ): Promise<SkillActionResult> => {
    if (!ownsCurrentAgent()) {
      return { success: false };
    }
    try {
      setUploading(true);
      const result = await api.uploadSkill(file, {
        enable: true,
        target_name: targetName,
        rename_map: renameMap,
      });
      if (result?.count > 0) {
        message.success(
          t("skills.uploadSuccess") + `: ${result.imported.join(", ")}`,
        );
        invalidateSkillCache({ agentId: selectedAgent }); // Clear cache after mutation
        await fetchSkills();
        for (const name of result.imported) {
          await checkScanWarnings(name);
        }
      }
      if (!result?.count) {
        message.warning(t("skills.uploadNoChange"));
      }
      await fetchSkills();
      return { success: true, imported: result?.imported || [] };
    } catch (error) {
      const detail = parseErrorDetail(error);
      if (Array.isArray(detail?.conflicts) && detail.conflicts.length > 0) {
        return { success: false, conflict: detail };
      }
      handleError(error, t("skills.uploadFailed"));
      return { success: false };
    } finally {
      setUploading(false);
    }
  };

  const importFromHub = async (
    input: string,
    targetName?: string,
  ): Promise<SkillActionResult> => {
    if (!ownsCurrentAgent()) {
      return { success: false };
    }
    const text = (input || "").trim();
    if (!text) {
      message.warning(t("skills.provideUrl"));
      return { success: false };
    }
    if (!text.startsWith("http://") && !text.startsWith("https://")) {
      message.warning(t("skills.validUrl"));
      return { success: false };
    }
    const timeoutMs = 90_000;
    const pollMs = 1_000;
    const startedAt = Date.now();
    try {
      setImporting(true);
      importCancelReasonRef.current = null;
      const payload = {
        bundle_url: text,
        enable: true,
        target_name: targetName,
      };
      const task = await api.startHubSkillInstall(payload);
      importTaskIdRef.current = task.task_id;

      while (importTaskIdRef.current) {
        const status = await api.getHubSkillInstallStatus(task.task_id);

        if (status.status === "completed" && status.result?.installed) {
          message.success(
            t("skills.importedSkill", { name: status.result.name }),
          );
          invalidateSkillCache({ agentId: selectedAgent }); // Clear cache after mutation
          await fetchSkills();
          if (status.result.name) {
            await checkScanWarnings(status.result.name);
          }
          return { success: true, name: String(status.result.name || "") };
        }

        if (status.status === "failed") {
          if (
            Array.isArray(status.result?.conflicts) &&
            status.result.conflicts.length > 0
          ) {
            return { success: false, conflict: status.result };
          }
          const hubResult = status.result as
            | SecurityScanErrorResponse
            | null
            | undefined;
          if (hubResult?.type === "security_scan_failed") {
            showScanErrorModal(hubResult, t);
            return { success: false };
          }
          throw new Error(status.error || t("skills.importFailed"));
        }

        if (status.status === "cancelled") {
          message.warning(
            t(
              importCancelReasonRef.current === "timeout"
                ? "skills.importTimeout"
                : "skills.importCancelled",
            ),
          );
          return { success: false };
        }

        if (Date.now() - startedAt >= timeoutMs) {
          importCancelReasonRef.current = "timeout";
          await api.cancelHubSkillInstall(task.task_id);
        }

        await new Promise((resolve) => window.setTimeout(resolve, pollMs));
      }

      return { success: false };
    } catch (error) {
      handleError(error, t("skills.importFailed"));
      return { success: false };
    } finally {
      importTaskIdRef.current = null;
      importCancelReasonRef.current = null;
      setImporting(false);
    }
  };

  const cancelImport = useCallback(() => {
    if (!importing) return;
    importCancelReasonRef.current = "manual";
    const taskId = importTaskIdRef.current;
    if (!taskId) return;
    void api.cancelHubSkillInstall(taskId);
  }, [importing]);

  const toggleEnabled = async (skill: SkillSpec) => {
    if (!ownsCurrentAgent()) return false;
    try {
      if (skill.enabled) {
        await api.disableSkill(skill.name);
        setSkills((prev) =>
          prev.map((s) =>
            s.name === skill.name ? { ...s, enabled: false } : s,
          ),
        );
        message.success(t("skills.disabledSuccessfully"));
      } else {
        await api.enableSkill(skill.name);
        setSkills((prev) =>
          prev.map((s) =>
            s.name === skill.name ? { ...s, enabled: true } : s,
          ),
        );
        message.success(t("skills.enabledSuccessfully"));
        await checkScanWarnings(skill.name);
      }
      invalidateSkillCache({ agentId: selectedAgent }); // Clear cache after mutation
      return true;
    } catch (error) {
      handleError(error, t("skills.operationFailed"));
      return false;
    }
  };

  const deleteSkill = async (skill: SkillSpec) => {
    if (!ownsCurrentAgent()) return false;
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("common.confirm"),
        content: t("skills.deleteConfirm"),
        okText: t("common.delete"),
        okType: "danger",
        cancelText: t("common.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

    if (!confirmed) return false;

    try {
      const result = await api.deleteSkill(skill.name);
      if (result.deleted) {
        message.success(t("skills.deleteSuccess"));
        invalidateSkillCache({ agentId: selectedAgent }); // Clear cache after mutation
        await fetchSkills();
        return true;
      }
    } catch (error) {
      console.error(t("skills.deleteFailed"), error);
      message.error(t("skills.deleteFailed"));
    }
    return false;
  };

  const currentAgent = selectedAgent || "default";
  const error = loadError?.agentId === currentAgent ? loadError.value : null;

  return {
    skills,
    providerSkills,
    loading,
    error,
    ready: !loading && error === null && loadedAgent === currentAgent,
    uploading,
    importing,
    createSkill,
    uploadSkill,
    importFromHub,
    cancelImport,
    toggleEnabled,
    deleteSkill,
    refreshSkills: fetchSkills,
    hardRefresh,
  };
}
