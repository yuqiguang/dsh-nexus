import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { ChannelError } from '../channels/types.js';

/** Who the assistant is when it talks to the user: name, how it addresses them, tone, and how much it volunteers. */
export interface PersonaSettings {
  /** What the assistant calls itself. */
  name: string;
  /** How it addresses the user; empty means no fixed form of address. */
  userName: string;
  tone: 'plain' | 'warm' | 'brisk';
  initiative: 'low' | 'medium' | 'high';
}

export const PERSONA_LIMITS = { nameChars: 20, userNameChars: 20 } as const;
export const TONES: Record<PersonaSettings['tone'], string> = { plain: '平实', warm: '亲切', brisk: '干练' };
export const INITIATIVES: Record<PersonaSettings['initiative'], string> = { low: '问什么答什么', medium: '顺带提醒', high: '主动建议' };

export const DEFAULT_PERSONA: PersonaSettings = { name: 'Nexus', userName: '', tone: 'plain', initiative: 'medium' };

/** Ready-made combinations the settings page offers; the user can still edit each field afterwards. */
export const PERSONA_TEMPLATES: { id: string; label: string; persona: Omit<PersonaSettings, 'userName'> }[] = [
  { id: 'assistant', label: '默认助理', persona: { name: 'Nexus', tone: 'plain', initiative: 'medium' } },
  { id: 'secretary', label: '干练秘书', persona: { name: '小秘', tone: 'brisk', initiative: 'high' } },
  { id: 'friend', label: '随和朋友', persona: { name: '阿星', tone: 'warm', initiative: 'medium' } },
];

const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Validate a persona from the settings page; missing fields fall back to the previous value. */
export function parsePersona(input: unknown, previous: PersonaSettings = DEFAULT_PERSONA): PersonaSettings {
  if (input === undefined) return previous;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChannelError('invalid_persona');
  const raw = input as Record<string, unknown>;
  const name = raw.name === undefined ? previous.name : clean(raw.name);
  const userName = raw.userName === undefined ? previous.userName : clean(raw.userName);
  const tone = raw.tone === undefined ? previous.tone : raw.tone;
  const initiative = raw.initiative === undefined ? previous.initiative : raw.initiative;
  if (!name || name.length > PERSONA_LIMITS.nameChars || userName.length > PERSONA_LIMITS.userNameChars) throw new ChannelError('invalid_persona');
  if (typeof tone !== 'string' || !(tone in TONES) || typeof initiative !== 'string' || !(initiative in INITIATIVES)) throw new ChannelError('invalid_persona');
  return { name, userName, tone: tone as PersonaSettings['tone'], initiative: initiative as PersonaSettings['initiative'] };
}

const TONE_TEXT: Record<PersonaSettings['tone'], string> = {
  plain: '语气平实自然，像一个熟悉情况的同事，不客套也不冷淡。',
  warm: '语气亲切随和，可以带一点口语和关心，但不要肉麻，不用表情符号堆砌。',
  brisk: '语气干练直接，先给结论，少铺垫，不寒暄。',
};
const INITIATIVE_TEXT: Record<PersonaSettings['initiative'], string> = {
  low: '只回答用户问的事，不主动给建议或提醒。',
  medium: '以回答用户的问题为主；看到明显相关的风险、冲突或遗漏时顺带提一句，不展开。',
  high: '除了回答，还主动提醒相关的日程、风险和下一步，并给出你的建议，供用户决定。',
};

/** The persona prefix that replaces the harness identity and the preset's coding-agent line. */
export function renderPersona(persona: PersonaSettings): string {
  const address = persona.userName ? `称呼用户“${persona.userName}”。` : '';
  return [
    `你是 ${persona.name}，用户的私人助理，用中文交流。${address}用户主要通过微信这类聊天软件和你说话，你的每条回复都会推送到用户手机上。`,
    `${TONE_TEXT[persona.tone]}${INITIATIVE_TEXT[persona.initiative]}`,
    '回复默认简短：两三句话说完，能一句话回答的不要分段；需要罗列时用短行，不用标题和表格。不要描述你调用了什么工具、读了什么文件或中间的推理过程，只给结果、结论和需要用户决定的事；做不到或没做完就直说。不要自称 AI 模型或提到底层框架，也不要重复系统消息里的框架文字。',
  ].join('\n');
}

/** Sections the persona replaces or removes; the rest of the prompt (tool guidance) is untouched. */
export const HARNESS_IDENTITY_SECTION = 'harness:identity';
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';

export interface PromptSection { name: string; text: string }

/** Apply the persona to an assembled prompt: drop the harness identity line and replace the persona prefix. */
export function applyPersona<T extends { sections: PromptSection[] }>(assembly: T, persona: PersonaSettings): T {
  const text = renderPersona(persona);
  let replaced = false;
  const sections = assembly.sections.flatMap(section => {
    if (section.name === HARNESS_IDENTITY_SECTION) return [];
    if (section.name === PERSONA_PREFIX_SECTION) { replaced = true; return [{ ...section, text }]; }
    return [section];
  });
  if (!replaced) sections.unshift({ name: PERSONA_PREFIX_SECTION, text });
  return { ...assembly, sections };
}

/**
 * Rewrite the identity of every root agent's prompt. Subagents keep the persona their parent's tool installed for them,
 * so they are left alone; the waterfall runs after the registry's own assembly and after the preset's persona row.
 */
export function installPersona(ctx: Context, current: () => PersonaSettings): void {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const header = context.agent?.session.header;
    if (header === undefined || header.parentSession !== undefined) return assembly;
    return applyPersona(assembly, current());
  });
}
