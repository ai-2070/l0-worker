import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelSpec } from "../inference/index.js";

/**
 * Provider registry - maps provider names to SDK instances.
 */
const providers: Record<string, ReturnType<typeof createOpenAI>> = {
  openai: createOpenAI({}),
};

/**
 * Get a language model instance from a ModelSpec.
 */
export function getModel(spec: ModelSpec): LanguageModel {
  const provider = providers[spec.provider];

  if (!provider) {
    throw new Error(`Unknown provider: ${spec.provider}`);
  }

  return provider(spec.model);
}

/**
 * Check if a provider is supported.
 */
export function isProviderSupported(providerName: string): boolean {
  return providerName in providers;
}
