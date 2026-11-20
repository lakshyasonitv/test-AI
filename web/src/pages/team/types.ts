
export type Feedback = { message: string; isError: boolean } | null;

export interface LlmConfig {
  keySet: boolean; keyHint?: string | null; custodyConfigured: boolean;
  model?: string | null; modelLite?: string | null; maxCallsPerRun?: number | null; availableModels: string[];
}
