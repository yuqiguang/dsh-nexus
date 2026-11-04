import test from 'node:test';
import assert from 'node:assert/strict';
import { plainChatText } from '../src/channels/plain-text.js';

test('chat text drops Markdown markup and workspace links but keeps the words and web addresses', () => {
  assert.equal(plainChatText('## 结果\n**已完成**：[简历.docx](<outputs/resume/简历.docx>)，见 [文档](https://example.com/a)。\n\n\n`npm test` 通过'),
    '结果\n已完成：简历.docx，见 文档（https://example.com/a）。\n\nnpm test 通过');
  assert.equal(plainChatText('| 项 | 状态 |\n|---|:---:|\n| a1 | 通过 |'), '项  状态\na1  通过');
  assert.equal(plainChatText('```\nnpm test\n```'), 'npm test');
  assert.equal(plainChatText('2 * 3 * 4，a_b_c，改了 __init__.py'), '2 * 3 * 4，a_b_c，改了 __init__.py');
  assert.equal(plainChatText('```python\nprint(2**3**2)\n| a | b |\n```'), 'print(2**3**2)\n| a | b |');
});
