import type { TaskRetry } from './retry.js';

export function retryText(retry: TaskRetry): string {
  const count = retry.attempt === undefined ? '' : `（第 ${retry.attempt}${retry.maxAttempts === undefined ? '' : `/${retry.maxAttempts}`} 次）`;
  return `${retry.source === 'tool' ? retry.phase === 'stopped' ? '编码工具请求受阻' : '编码工具自行重试' : '自动续接'}${count}：${retry.reason}`
    + (retry.waitedMs ? `；未观察到成功操作期间累计重试等待 ${Math.floor(retry.waitedMs / 1000)} 秒${retry.prolonged ? '，已长时间没有执行进展' : ''}` : '');
}
