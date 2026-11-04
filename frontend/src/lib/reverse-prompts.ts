import { writable } from "svelte/store";
import { http } from "./api";

export interface ProviderModel { id: string; label: string; recommended: boolean }
/**
 * 一家预设服务商。两个字段决定界面长什么样：
 * - credential_scope "cloud" = 这把 Key 的家在「RunningHub 云端生成」那条账号里，
 *   这条模型配置不另存一份（RunningHub 一把 Key 走天下，存两份迟早对不上）；
 * - models_dynamic = 模型清单由服务商自己报（下面 configModels），代码里不抄一份会过期的表。
 */
export interface ProviderPreset {
  id: string; name: string; base_url: string; models: ProviderModel[]; default_timeout: number; note?: string;
  credential_scope?: string; models_dynamic?: boolean;
  /** 只有共用 Key 那几家带：那把 Key 存了没有。是布尔，永远不是 Key 本身。 */
  shared_has_key?: boolean;
  /** 这家真接了哪几路（text=反推，image/video/audio=云端收费模型）。卡片区按它过滤，不靠前端猜。 */
  capabilities?: string[];
  /** 有第二把 Key（工作流·消费级-会员）的那家为 true；回前端的同样只有「有没有」。 */
  workflow_key?: boolean;
  shared_has_workflow_key?: boolean;
  /** 厂商控制台外链。没确认过的家留空，界面就不画那颗按钮。 */
  console_url?: string;
}
export interface ProviderModelList { models: ProviderModel[]; source: string; reason: string }
/**
 * 一条服务商配置 = 这一家的地址 + 这把 Key，仅此而已。
 * model 是「这一家当前用哪个模型」，空串＝还没挑过。挑模型的入口在反推面板的模型下拉里，
 * 不在设置页——存 Key 不需要先决定用哪个脑子。
 */
export interface ModelConfig {
  id: number; name: string; base_url: string; model: string; timeout: number;
  provider: string | null; has_api_key: boolean; key_persistence: "encrypted" | "session";
}
export type ModelDraft = {
  name?: string; base_url?: string;
  /** 可以不带：存 Key 不需要先挑模型，不带＝这条配置的模型还没定。 */
  model?: string; timeout?: number;
  provider?: string | null; api_key?: string; config_id?: number;
  /** RunningHub 的第二把（工作流·消费级）。只有那一家能带，落进云端账号另一列。 */
  workflow_api_key?: string;
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
  /** 即时拿掉一条配置自带的 Key：别的字段一个字不动，也不用先把表单填全。 */
  clearModelKey: (id: number) => http<ModelConfig>(`/api/model-configs/${id}/key`, { method: "DELETE" }),
  /** 即时拿掉共用那把 Key（或工作流那把），从它真正的家——云端那一行账号。回的只有布尔。 */
  clearProviderKey: (provider: string, kind: "model" | "workflow" = "model") =>
    http<{ shared_has_key: boolean; shared_has_workflow_key: boolean }>(
      `/api/model-providers/${encodeURIComponent(provider)}/key?kind=${kind}`, { method: "DELETE" }),
  /** 这条配置能挑哪些模型：预设照注册表，自定义问它自己的 /models。 */
  configModels: (id: number) => http<ProviderModelList>(`/api/model-configs/${id}/models`),
  /** 这把 Key 能不能用，问它自己的模型清单——不挑模型，也不产生模型调用费用。 */
  checkKey: (draft: ModelDraft) =>
    http<{ ok: boolean; count: number; models: string[]; source: string }>(
      "/api/model-configs/check-key", json("POST", draft)),
  /** 只改「这一家当前用哪个模型」，其余字段一个字不动。 */
  setModel: (id: number, model: string) => http<ModelConfig>(`/api/model-configs/${id}`, json("PATCH", { model })),
  settings: () => http<ReverseSettings>("/api/reverse-prompt-settings"),
  saveSettings: (value: ReverseSettings) => http<ReverseSettings>("/api/reverse-prompt-settings", json("PUT", value)),
  history: (id: number, offset = 0) => http<History>(`/api/images/${id}/reverse-prompts?offset=${offset}`),
  generate: (id: number, model: number, modelName?: string) =>
    http<ReverseRecord>(`/api/images/${id}/reverse-prompts`, json("POST", { model_config_id: model, model: modelName || null })),
  edit: (id: number, parent_id: number, prompt_zh: string, prompt_en: string) => http<ReverseRecord>(`/api/images/${id}/reverse-prompts/edits`, json("POST", { parent_id, prompt_zh, prompt_en })),
  /** 删掉一个历史版本；删的正好是最新版时 current 回退成次新一版，全删完回 null。 */
  remove: (id: number, recordId: number) => http<{ deleted: number; current: number | null }>(
    `/api/images/${id}/reverse-prompts/${recordId}`, { method: "DELETE" }),
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
/** 挑完模型顺手记在这条配置上：下次打开、以及视频反推那一侧都从同一处读，不用各记一份。 */
export async function rememberConfigModel(configId: number, model: string) {
  const saved = await reverseApi.setModel(configId, model);
  modelConfigs.update(list => list.map(item => (item.id === saved.id ? saved : item)));
  return saved;
}
export async function generateReverse(id: number, model: number, modelName?: string) {
  if (active.has(id)) return;
  active.add(id);
  reverseJobs.update(j => ({ ...j, [id]: { running: true } }));
  try {
    const result = await reverseApi.generate(id, model, modelName);
    reverseJobs.update(j => ({ ...j, [id]: { running: false, result } }));
  } catch (error) {
    reverseJobs.update(j => ({ ...j, [id]: { running: false, error: errorMessage(error) } }));
  } finally { active.delete(id); }
}
