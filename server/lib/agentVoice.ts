/**
 * 按 Agent 绑定默认声音（P2 #47，随 #41 MCP 落地的最小面）。
 *
 * 数据存 app_settings（迁移 0007）：
 *   mcp.agentVoices  { [agent标识]: voiceName }   —— MCP generate_speech 的 agent 参数（协作式自报）
 *   mcp.defaultVoice string | null                —— 全局默认（voice 与 agent 均省略时）
 *
 * 解析顺序（resolveAgentDefaultVoice）：
 *   agent 显式绑定 → 全局默认 → 库中唯一已发布 Profile → 都没有则报错并列出可用声音。
 * 任何一步解析出的 voice 都必须当前已发布（冻结目录 + manifest 校验通过），
 * 绝不解析到候选/草稿（硬性约束 #41）；已配置但失效的绑定/默认同样如实报错，
 * 不静默降级到下一步。
 *
 * 管理：GET/PUT /api/mcp/voice-bindings（curl/脚本即可，不做 UI——
 * 文档明示这是 Agent 集成能力，不是桌面首版基础能力）。
 */
import { getSetting, setSetting } from '../db/settingsStore';
import { listPublishedVoiceProfiles, type PublishedProfileSummary } from './profileManifest';

export const AGENT_VOICES_KEY = 'mcp.agentVoices';
export const DEFAULT_VOICE_KEY = 'mcp.defaultVoice';

export const AGENT_KEY_PATTERN = /^[^\s]{1,120}$/;

export interface AgentVoiceBindings {
  agentVoices: Record<string, string>;
  defaultVoice: string | null;
}

export class AgentVoiceUnresolvedError extends Error {
  constructor(readonly availableVoices: string[]) {
    super(
      availableVoices.length > 0
        ? `未配置默认声音，且库中不只有一个已发布 Voice Profile。请显式传入 voice（可用：${availableVoices.join('、')}），或用 PUT /api/mcp/voice-bindings 配置绑定。`
        : '库中没有任何已发布 Voice Profile，无法解析默认声音。请先在产品内冻结并发布一个 Voice Profile。'
    );
    this.name = 'AgentVoiceUnresolvedError';
  }
}

export function readAgentVoiceBindings(): AgentVoiceBindings {
  const raw = getSetting<Record<string, unknown>>(AGENT_VOICES_KEY);
  const agentVoices: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [agent, voice] of Object.entries(raw)) {
      if (typeof voice === 'string' && AGENT_KEY_PATTERN.test(agent)) agentVoices[agent] = voice;
    }
  }
  const defaultVoice = getSetting<string>(DEFAULT_VOICE_KEY);
  return { agentVoices, defaultVoice: typeof defaultVoice === 'string' && defaultVoice ? defaultVoice : null };
}

export function writeAgentVoiceBindings(bindings: AgentVoiceBindings): void {
  setSetting(AGENT_VOICES_KEY, bindings.agentVoices);
  setSetting(DEFAULT_VOICE_KEY, bindings.defaultVoice);
}

/** 校验 voiceName 是当前已发布的 Profile；返回其摘要，未发布/不存在时抛错（绝不放行候选/草稿） */
export async function assertPublishedVoice(voiceName: string): Promise<PublishedProfileSummary> {
  const { profiles } = await listPublishedVoiceProfiles();
  const found = profiles.find(profile => profile.voiceName === voiceName);
  if (!found) {
    throw new Error(`voiceName ${voiceName} 不是当前已发布的 Voice Profile（候选/草稿不可绑定）。可用：${profiles.map(p => p.voiceName).join('、') || '（无）'}`);
  }
  return found;
}

export type VoiceResolvedFrom = 'agent-binding' | 'default-voice' | 'single-profile';

export interface VoiceResolution {
  voiceName: string;
  resolvedFrom: VoiceResolvedFrom;
}

/** voice 省略时的默认声音解析（顺序见文件头）；解析结果当场验证仍在发布集内 */
export async function resolveAgentDefaultVoice(agent?: string): Promise<VoiceResolution> {
  const [{ agentVoices, defaultVoice }, { profiles }] = await Promise.all([
    Promise.resolve(readAgentVoiceBindings()),
    listPublishedVoiceProfiles(),
  ]);
  const published = new Set(profiles.map(profile => profile.voiceName));

  if (agent && agentVoices[agent]) {
    const bound = agentVoices[agent];
    if (published.has(bound)) return { voiceName: bound, resolvedFrom: 'agent-binding' };
    // 绑定指向的 Profile 已不在发布集（被删/损坏）：不静默降级，如实报错
    throw new Error(`Agent「${agent}」绑定的声音 ${bound} 已不可用（不在当前发布集中）。请用 PUT /api/mcp/voice-bindings 更新绑定。`);
  }
  if (defaultVoice) {
    if (published.has(defaultVoice)) return { voiceName: defaultVoice, resolvedFrom: 'default-voice' };
    // 全局默认已失效：同样不静默落到「唯一 Profile 兜底」，如实报错
    throw new Error(`全局默认声音 ${defaultVoice} 已不可用（不在当前发布集中）。请用 PUT /api/mcp/voice-bindings 更新或清除默认。`);
  }
  if (profiles.length === 1) {
    return { voiceName: profiles[0].voiceName, resolvedFrom: 'single-profile' };
  }
  throw new AgentVoiceUnresolvedError(profiles.map(profile => profile.voiceName));
}
