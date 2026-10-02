import type { TaskRetry } from './retry.js';

export function retryText(retry: TaskRetry): string {
  const count = retry.attempt === undefined ? '' : `（第 ${retry.attempt}${retry.maxAttempts === undefined ? '' : `/${retry.maxAttempts}`} 次）`;
  return `${retry.source === 'tool' ? retry.phase === 'stopped' ? '编码工具请求受阻' : '编码工具自行重试' : '自动续接'}${count}：${retry.reason}`;
}

