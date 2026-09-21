import { writable } from "svelte/store";
import { http } from "./api";

export interface ProviderModel { id: string; label: string; recommended: boolean }
export interface ProviderPreset { id: string; name: string; base_url: string; models: ProviderModel[]; default_timeout: number; note?: string }
export interface ModelConfig {
  id: number; name: string; base_url: string; model: string; timeout: number;
  provider: string | null; has_api_key: boolean; key_persistence: "encrypted" | "session";
}
export type ModelDraft = {
  name?: string; base_url?: string; model: string; timeout?: number;
  provider?: string | null; api_key?: string; config_id?: number;
};
export interface ReverseSettings { default_model_id: number | null; instruction: string; default_instruction: string }
export interface ReverseRecord {
  id: number; image_id: number; prompt_zh: string; prompt_en: string; raw_text: string;
  status: "complete" | "unstructured"; source: "generated" | "edited"; parent_id: number | null;
  model_name: string; model: string; instruction: string; fingerprint: string; created_at: string; image_changed?: boolean;
}
export interface History { items: ReverseRecord[]; total: number; running: boolean }
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
export const reverseApi = {
  models: () => http<ModelConfig[]>("/api/model-configs"),
  providers: () => http<ProviderPreset[]>("/api/model-providers"),
  saveModel: (draft: ModelDraft, id?: number) => http<ModelConfig>(`/api/model-configs${id ? `/${id}` : ""}`, json(id ? "PATCH" : "POST", draft)),
  deleteModel: (id: number) => http(`/api/model-configs/${id}`, { method: "DELETE" }),
  test: (draft: ModelDraft) => http<{ message: string; text: string }>("/api/model-configs/test", json("POST", draft)),
  settings: () => http<ReverseSettings>("/api/reverse-prompt-settings"),
  saveSettings: (value: ReverseSettings) => http<ReverseSettings>("/api/reverse-prompt-settings", json("PUT", value)),
  history: (id: number, offset = 0) => http<History>(`/api/images/${id}/reverse-prompts?offset=${offset}`),
  generate: (id: number, model: number) => http<ReverseRecord>(`/api/images/${id}/reverse-prompts`, json("POST", { model_config_id: model })),
  edit: (id: number, parent_id: number, prompt_zh: string, prompt_en: string) => http<ReverseRecord>(`/api/images/${id}/reverse-prompts/edits`, json("POST", { parent_id, prompt_zh, prompt_en })),
};
export const modelConfigs = writable<ModelConfig[]>([]);
export const reverseSettings = writable<ReverseSettings | null>(null);
export const providerPresets = writable<ProviderPreset[]>([]);
export async function refreshProviderPresets() {
  try {
    providerPresets.set(await reverseApi.providers());
  } catch {
    providerPresets.set([]);
  }
}
export async function refreshReverseConfig() {
  const [models, settings] = await Promise.all([reverseApi.models(), reverseApi.settings()]);
  modelConfigs.set(models); reverseSettings.set(settings);
}
export const reverseJobs = writable<Record<number, { running: boolean; error?: string; result?: ReverseRecord }>>({});
const active = new Set<number>();
export function errorMessage(error: unknown) {
  return (error as { detail?: string })?.detail || "请求失败，请检查服务连接后重试";
}
// Lives outside the detail component: navigating away never abandons or misattributes a result.
export async function generateReverse(id: number, model: number) {
  if (active.has(id)) return;
  active.add(id);
  reverseJobs.update(j => ({ ...j, [id]: { running: true } }));
  try {
    const result = await reverseApi.generate(id, model);
    reverseJobs.update(j => ({ ...j, [id]: { running: false, result } }));
  } catch (error) {
    reverseJobs.update(j => ({ ...j, [id]: { running: false, error: errorMessage(error) } }));
  } finally { active.delete(id); }
}
