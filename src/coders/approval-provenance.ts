import { createHash } from 'node:crypto';
import type { CoderRequest, DecisionRecord, TaskRecord } from './types.js';
import { redact } from './normalize.js';

/** A receipt for one native owner answer, never a reusable permission. Native sessions retain the full request. */
export interface ApprovalProvenance {
  source: 'native-user-question';
  scope: 'once';
  taskId: string;
  ownerSession: string;
  cwd: string;
  briefId?: string;
  briefRevision?: number;
  operationId: string;
}

export function approvalProvenance(task: TaskRecord, request: CoderRequest): ApprovalProvenance {
  return { source: 'native-user-question', scope: 'once', taskId: task.id, ownerSession: task.ownerSession,
    cwd: typeof request.raw.cwd === 'string' ? request.raw.cwd : task.cwd,
    ...(task.brief ? { briefId: task.brief.id, briefRevision: task.brief.revision } : {}),
    operationId: createHash('sha256').update(JSON.stringify({ taskId: task.id, owner: task.ownerSession, cwd: task.cwd,
      brief: task.brief && { id: task.brief.id, revision: task.brief.revision }, permissions: task.permissions,
      kind: request.kind, tool: request.tool, command: request.command, paths: request.paths, raw: request.raw })).digest('hex') };
}

/** Only host-recorded answers from this run are context. No chat reconstruction or model-written grant claims. */
export function priorApprovalEvidence(task: TaskRecord): string[] {
  return task.decisions.filter((record): record is DecisionRecord & { authorization: ApprovalProvenance } => {
    const receipt = record.authorization;
    return !!receipt && receipt.source === 'native-user-question' && receipt.scope === 'once'
      && record.layer === 'user' && ['allow', 'deny'].includes(record.outcome)
      && receipt.taskId === task.id && receipt.ownerSession === task.ownerSession
      && receipt.briefId === task.brief?.id && receipt.briefRevision === task.brief?.revision;
  }).slice(-8).map(record => `原生用户回答 ${record.at}：${record.outcome === 'allow' ? '允许' : '拒绝'}；${redact(record.summary)}；目录 ${redact(record.authorization.cwd)}；操作 ${record.authorization.operationId}。仅该次请求有效，已使用；不授权当前请求、扩大参数或续接任务。`);
}
