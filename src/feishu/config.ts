export interface FeishuConfig {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
}

export function readFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | undefined {
  const enabled = env.NEXUS_FEISHU_ENABLED ?? '0';
  if (enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('NEXUS_FEISHU_ENABLED must be 0 or 1.');
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}.`);
    return value;
  };
  return {
    appId: required('NEXUS_FEISHU_APP_ID'),
    appSecret: required('NEXUS_FEISHU_APP_SECRET'),
    ownerOpenId: required('NEXUS_FEISHU_OWNER_OPEN_ID'),
  };
}
