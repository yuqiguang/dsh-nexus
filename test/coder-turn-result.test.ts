import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurnResult } from '../src/coders/turn-result.js';

test('questions, quoted FAQs and optional suggestions never override explicit result state', () => {
  for (const text of ['已修复并通过测试。要不要顺便加深色模式？', '文档已更新。\n新增 FAQ：如何安装？', 'Done. Anything else?']) {
    assert.equal(parseTurnResult(JSON.stringify({ status: 'completed', text }))?.status, 'completed');
  }
  for (const text of ['如果需要我继续，请确认目标目录。', '目录中有两个文件，请告诉我改哪个。']) {
    assert.equal(parseTurnResult(JSON.stringify({ status: 'needs_input', text }))?.status, 'needs_input');
  }
  for (const raw of ['请确认目录。', '', '{}', '{"status":"completed","text":""}', '{"status":"unknown","text":"done"}', '{"status":"completed","text":"done","extra":true}']) assert.equal(parseTurnResult(raw), undefined);
});
