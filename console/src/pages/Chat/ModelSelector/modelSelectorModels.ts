import type { ModelInfo, ModelType, ProviderInfo } from "../../../api/types";

export interface EligibleProvider {
  id: string;
  name: string;
  models: ProviderInfo["models"];
  is_free_tier?: boolean;
  is_custom?: boolean;
  is_local?: boolean;
  supports_oauth?: boolean;
  oauth_connected?: boolean;
  has_api_key?: boolean;
  require_api_key?: boolean;
}

export interface CandidateModel {
  provider: ProviderInfo;
  model: ModelInfo;
}

export function splitProvidersByTier(providers: EligibleProvider[]): {
  freeProviders: EligibleProvider[];
  proProviders: EligibleProvider[];
} {
  const freeProviders: EligibleProvider[] = [];
  const proProviders: EligibleProvider[] = [];
  for (const provider of providers) {
    const freeModels = provider.models.filter((model) => model.is_free);
    const proModels = provider.models.filter((model) => !model.is_free);
    if (freeModels.length > 0 || provider.is_free_tier) {
      freeProviders.push({ ...provider, models: freeModels });
    }
    if (
      (proModels.length > 0 || provider.id === "hub-managed") &&
      (provider.has_api_key ||
        provider.require_api_key === false ||
        provider.is_custom ||
        provider.is_local)
    ) {
      proProviders.push({ ...provider, models: proModels });
    }
  }
  return { freeProviders, proProviders };
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function buildEligibleProviders(
  providers: ProviderInfo[],
  modelType: ModelType = "chat",
): EligibleProvider[] {
  return providers.flatMap((provider) => {
    if (provider.enabled === false) return [];
    const models = [
      ...(provider.models ?? []),
      ...(provider.extra_models ?? []),
    ].filter((model) => (model.model_type ?? "chat") === modelType);
    const managedOrFreeChat =
      modelType === "chat" &&
      (provider.id === "hub-managed" || provider.is_free_tier);
    const configured =
      provider.is_custom || provider.require_api_key === false
        ? Boolean(provider.base_url)
        : Boolean(provider.api_key);
    if (!models.length && provider.chat_model === "") return [];
    if (!managedOrFreeChat && (!models.length || !configured)) return [];
    return [
      {
        id: provider.id,
        name: provider.name,
        models,
        is_free_tier: provider.is_free_tier,
        is_custom: provider.is_custom,
        is_local: provider.is_local,
        supports_oauth: provider.supports_oauth,
        oauth_connected: provider.oauth_connected,
        has_api_key: Boolean(provider.api_key),
        require_api_key: provider.require_api_key,
      },
    ];
  });
}

export function buildDiscoveryCandidates(
  providers: ProviderInfo[],
  modelType: ModelType = "chat",
): CandidateModel[] {
  const configured = new Set(
    providers.flatMap((provider) =>
      [...(provider.models ?? []), ...(provider.extra_models ?? [])].map(
        (model) => modelKey(provider.id, model.id),
      ),
    ),
  );
  return providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) =>
      (provider.discovered_models ?? [])
        .filter(
          (model) =>
            (model.model_type ?? "chat") === modelType &&
            !configured.has(modelKey(provider.id, model.id)) &&
            !(provider.hidden_model_ids ?? []).includes(model.id),
        )
        .map((model) => ({ provider, model })),
    );
}

export function buildHiddenCandidates(
  providers: ProviderInfo[],
  modelType: ModelType = "chat",
): CandidateModel[] {
  return providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) => {
      const hidden = new Set(provider.hidden_model_ids ?? []);
      return (provider.discovered_models ?? [])
        .filter(
          (model) =>
            (model.model_type ?? "chat") === modelType && hidden.has(model.id),
        )
        .map((model) => ({ provider, model }));
    });
}
