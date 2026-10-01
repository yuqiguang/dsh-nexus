import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import { decideLayers } from '../src/coders/decide.js';
import { escalateToUser, type EscalationHost } from '../src/coders/escalate.js';
import { commandCovers, commandMatches, describeRule, globToRegExp, habitRule, isHarmless, isOpaque, parseHeredocs, parseRuleBlocks, parseRuleLine, pathMatches,
  projectRules, redirectTargets, splitSegments, tokens, unwrapShell } from '../src/coders/habits.js';
import { CoderStore, type CoderDomain, type DomainOpener } from '../src/coders/store.js';
import type { CoderRequest, HabitRule, TaskRecord } from '../src/coders/types.js';

const roots = ['/home/dev/project'];
const cwd = '/home/dev/project/app';

function command(text: string, paths: string[] = []): CoderRequest {
  return { kind: 'command', tool: 'Bash', summary: `Bash: ${text}`, detail: text, command: text, paths, raw: { command: text } };
}

function write(path: string): CoderRequest {
  return { kind: 'file-write', tool: 'codex.fileChange', summary: `改动文件：${path}`, detail: '+x', paths: [path], raw: {} };
}

function question(text: string, header?: string): CoderRequest {
  return { kind: 'question', tool: 'codex.message', summary: text, detail: text, paths: [],
    questions: [{ question: text, ...(header ? { header } : {}), options: [], multiSelect: false }], raw: { text } };
}

let counter = 0;
function rule(overrides: Partial<HabitRule> & Pick<HabitRule, 'kind' | 'pattern' | 'decision'>): HabitRule {
  return { id: `cr-${++counter}`, source: 'user', createdAt: counter, ...overrides };
}

test('shell wrappers, compound commands, and quoting are taken apart lexically', () => {
  assert.equal(unwrapShell(`/bin/bash -lc 'ls -la'`), 'ls -la');
  assert.equal(unwrapShell(`bash -lc "npm test && git status"`), 'npm test && git status');
  assert.equal(unwrapShell('npm test'), 'npm test');
  assert.deepEqual(splitSegments('npm test && git status; ls | wc -l'), ['npm test', 'git status', 'ls', 'wc -l']);
  assert.deepEqual(splitSegments(`echo "a && b" || true`), ['echo "a && b"', 'true']);
  assert.deepEqual(splitSegments('npm test 2>&1'), ['npm test 2>&1']);
  assert.deepEqual(splitSegments('a\nb'), ['a', 'b']);
  assert.deepEqual(tokens(`FOO=1 /usr/bin/npm run "build:all"`), ['npm', 'run', 'build:all']);
  assert.deepEqual(tokens(`git commit -m 'fix it'`), ['git', 'commit', '-m', 'fix it']);
});

test('compound statements: shell keywords are not programs, harmless segments and control syntax need no rule', () => {
  assert.deepEqual(tokens('then cat -A app.yaml'), ['cat', '-A', 'app.yaml']);
  assert.deepEqual(tokens('if [ -f app.yaml ]'), ['[', '-f', 'app.yaml', ']']);
  assert.deepEqual(tokens('if ! grep -q x y'), ['grep', '-q', 'x', 'y']);
  assert.deepEqual(tokens('do wc -l "$f"'), ['wc', '-l', '$f']);
  assert.deepEqual(tokens('{ ls'), ['ls']);
  assert.deepEqual(tokens('(cd app'), ['cd', 'app']);
  assert.deepEqual(tokens('npm test)'), ['npm', 'test']);
  for (const syntax of ['fi', 'done', 'esac', '}', ')', 'for f in *.ts', 'done < input.txt']) assert.deepEqual(tokens(syntax), [], syntax);
  for (const harmless of ['echo ---', 'printf "%s" x', 'test -f x', '[ -f x ]', 'cd app', 'exit 1', 'export X=1', 'fi', 'for f in *']) assert.equal(isHarmless(harmless), true, harmless);
  for (const notHarmless of ['echo hi > notes.txt', 'echo hi >> log', 'cat x', 'done > out', 'rm -rf dist']) assert.equal(isHarmless(notHarmless), false, notHarmless);
  assert.equal(isHarmless('echo hi 2>/dev/null'), true);
  assert.equal(isHarmless('echo hi >&2'), true);
  const script = 'echo ---; if [ -f app.yaml ]; then cat -A app.yaml; fi';
  const rules = [rule({ kind: 'command', pattern: 'cat', decision: 'allow' }), rule({ kind: 'command', pattern: 'echo', decision: 'deny' })];
  assert.equal(habitRule(command(script), rules, cwd)?.decision, 'deny', 'a deny rule still sees harmless segments');
  assert.equal(habitRule(command('if [ -f app.yaml ]; then cat -A app.yaml; fi'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command('test -f x && rm -rf dist'), rules, cwd), undefined);
  assert.equal(habitRule(command('echo hi'), [], cwd)?.decision, 'allow', 'the builtin rule covers harmless commands');
  assert.equal(habitRule(command('echo hi > x.txt'), [], cwd), undefined, 'a redirection makes echo a write');
  assert.equal(commandMatches('cat', 'then cat -A x'), true);
  assert.equal(commandMatches('fi', 'fi'), false, 'a syntax-only pattern matches nothing');
});

test('a heredoc body stays with the command that opened it and never becomes commands or rules', () => {
  // The write from ct-e57810c0, as Codex sent it: one bash -lc with a heredoc followed by more commands.
  const real = `/bin/bash -lc "cat > config.yaml << 'EOF'\nname: nexus-playground\nenvironment: development\ndebug: false\nEOF\nls -la config.yaml && echo \\"----\\" && cat config.yaml"`;
  const segments = splitSegments(unwrapShell(real));
  assert.deepEqual(segments, [`cat > config.yaml << 'EOF'\nname: nexus-playground\nenvironment: development\ndebug: false\nEOF`, 'ls -la config.yaml', 'echo \\"----\\"', 'cat config.yaml']);
  assert.deepEqual(tokens(segments[0]!), ['cat', '>', 'config.yaml']);
  assert.deepEqual(parseHeredocs(segments[0]!).heredocs, [{ delimiter: 'EOF', quoted: true, body: 'name: nexus-playground\nenvironment: development\ndebug: false\n' }]);
  // The body belongs to the opening command even when other commands follow on the same line.
  assert.deepEqual(splitSegments('cat <<EOF | tee out.txt; ls\nline one; still && body | here\nEOF\npwd'),
    ['cat <<EOF\nline one; still && body | here\nEOF', 'tee out.txt', 'ls', 'pwd']);
  assert.deepEqual(splitSegments('cat <<-END > x\n\tindented\n\tEND\nls'), ['cat <<-END > x\n\tindented\n\tEND', 'ls']);
  assert.deepEqual(tokens('cat <<EOF > x\nbody\nEOF'), ['cat', '>', 'x'], 'the operator position does not matter');
  assert.deepEqual(splitSegments('cat <<EOF\nnever terminated; ls'), ['cat <<EOF\nnever terminated; ls'], 'an unterminated body runs to the end');
  assert.deepEqual(tokens('cat <<< "hi"'), ['cat', '<<<', 'hi'], 'a here-string is not a heredoc');
  assert.deepEqual(splitSegments('echo "<<EOF"; ls'), ['echo "<<EOF"', 'ls'], 'a quoted << is text');
  assert.deepEqual(redirectTargets('cat > run.sh <<EOF\nls > out.txt\nEOF'), ['run.sh'], 'redirections inside the body are data');
  assert.equal(isOpaque('bash <<EOF\nrm -rf x\nEOF'), true, 'a heredoc fed to a shell is a script');
  assert.equal(isOpaque('cat <<EOF\n$(rm -rf x)\nEOF'), true, 'an unquoted delimiter expands the body');
  assert.equal(isOpaque(`cat <<'EOF'\n$(rm -rf x)\nEOF`), false, 'a quoted delimiter keeps the body literal');
  assert.equal(isOpaque('cat > /tmp/x <<EOF\nbody\nEOF'), true);
});

test('an allow rule covers a command only when both write the same files; a deny rule matches by prefix', () => {
  assert.deepEqual(redirectTargets('cat a > b'), ['b']);
  assert.deepEqual(redirectTargets('cat a>b 2>/dev/null'), ['b'], 'no space before > is still a redirection');
  assert.deepEqual(redirectTargets('cat a >| b >> c &> d 2>&1 >&2'), ['b', 'c', 'd']);
  assert.deepEqual(splitSegments('cat a >| b'), ['cat a >| b'], '>| is a redirection, not a pipe');
  assert.equal(commandCovers('cat', 'cat a'), true);
  assert.equal(commandCovers('cat', 'cat a > b'), false);
  assert.equal(commandCovers('cat', 'cat a >> b'), false);
  assert.equal(commandCovers('cat a > b', 'cat a > b'), true);
  assert.equal(commandCovers('cat a > b', 'cat a > c'), false);
  assert.equal(commandCovers('cat > config.yaml', `cat > config.yaml << 'EOF'\nanything\nEOF`), true, 'the body is not part of the rule');
  assert.equal(commandCovers('cat > config.yaml', 'cat config.yaml'), false);
  assert.equal(commandMatches('cat', 'cat a > b'), true);
  const rules = [rule({ kind: 'command', pattern: 'ls', decision: 'allow' }), rule({ kind: 'command', pattern: 'cat', decision: 'allow' }),
    rule({ kind: 'command', pattern: 'cat > config.yaml', decision: 'allow' }), rule({ kind: 'command', pattern: 'sort', decision: 'deny' })];
  assert.equal(habitRule(command('cat app.yaml > copy.yaml'), rules, cwd), undefined, 'a read-only rule does not cover a write');
  assert.equal(habitRule(command('ls > out.txt'), rules, cwd), undefined);
  assert.equal(habitRule(command('ls -la && cat app.yaml'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command(`cat > config.yaml << 'EOF'\nname: x\nEOF\nls -la config.yaml && echo "----" && cat config.yaml`), rules, cwd)?.rule.pattern, 'cat > config.yaml');
  assert.equal(habitRule(command('cat > other.yaml <<EOF\nx\nEOF'), rules, cwd), undefined);
  assert.equal(habitRule(command('sort a > b'), rules, cwd)?.decision, 'deny', 'deny still matches a write by prefix');
  assert.equal(habitRule(command('cat a | sort > b'), rules, cwd)?.decision, 'deny');
});

test('command patterns match leading tokens and never a prefix of a longer word', () => {
  assert.equal(commandMatches('npm test', 'npm test -- --grep x'), true);
  assert.equal(commandMatches('npm test', 'npm tests'), false);
  assert.equal(commandMatches('npm test', 'npm'), false);
  assert.equal(commandMatches('git commit', `git commit -m "x"`), true);
  assert.equal(commandMatches('ls', '/bin/ls -la'), true);
  assert.equal(commandMatches('', 'ls'), false);
});

test('opaque constructs are never auto-allowed', () => {
  for (const text of ['eval "$X"', 'bash -c "rm -rf ."', 'echo $(cat x)', 'xargs rm', 'source ./env.sh', '. ./env.sh',
    'npm test > /tmp/out.txt', 'ls > ~/x', 'cat a > $HOME/b', 'sudo ls']) {
    assert.equal(isOpaque(text), true, text);
  }
  for (const text of ['npm test 2>&1', 'ls > out.txt', 'ls > /dev/null', 'echo "$(x)"'.replace('$(x)', 'literal')]) {
    assert.equal(isOpaque(text), false, text);
  }
});

test('path globs anchor at the task directory and support ** and trailing slashes', () => {
  assert.equal(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'), true);
  assert.equal(globToRegExp('src/**/*.ts').test('src/c.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a/b.ts'), false);
  assert.equal(globToRegExp('*.md').test('.md'), true);
  assert.equal(pathMatches('src/**', `${cwd}/src/a/b.ts`, cwd), true);
  assert.equal(pathMatches('src/', `${cwd}/src/a/b.ts`, cwd), true);
  assert.equal(pathMatches('src/**', `${cwd}/lib/a.ts`, cwd), false);
  assert.equal(pathMatches('/etc/**', '/etc/hosts', cwd), true);
  assert.equal(pathMatches('docs/*.md', `${cwd}/docs/README.md`, cwd), true);
  assert.equal(pathMatches('docs/*.md', `${cwd}/docs/sub/README.md`, cwd), false);
});

test('habit rules allow only when every part is covered, and any deny wins', () => {
  const rules = [rule({ kind: 'command', pattern: 'npm test', decision: 'allow' }), rule({ kind: 'command', pattern: 'git status', decision: 'allow' }),
    rule({ kind: 'command', pattern: 'git commit', decision: 'deny' })];
  assert.equal(habitRule(command('npm test'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command('npm test && git status'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command('cd app && npm test'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command('npm test && rm -rf dist'), rules, cwd), undefined);
  assert.equal(habitRule(command(`/bin/bash -lc 'npm test'`), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command('npm test && git commit -m x'), rules, cwd)?.decision, 'deny');
  assert.equal(habitRule(command('git commit -m x || npm test'), rules, cwd)?.decision, 'deny');
  assert.equal(habitRule(command('npm test > /tmp/x'), rules, cwd), undefined);
  assert.equal(habitRule(command('cd app'), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(command(''), rules, cwd), undefined);
  assert.equal(habitRule(command('npm run build'), [], cwd), undefined);
});

test('habit rules cover paths, questions, and other tools by kind', () => {
  const rules = [rule({ kind: 'file-write', pattern: 'src/**', decision: 'allow' }), rule({ kind: 'file-write', pattern: 'src/generated/**', decision: 'deny' }),
    rule({ kind: 'question', pattern: '包管理', decision: 'answer', answer: 'pnpm' }), rule({ kind: 'other', pattern: 'mcp__*', decision: 'allow' })];
  assert.equal(habitRule(write(`${cwd}/src/a.ts`), rules, cwd)?.decision, 'allow');
  assert.equal(habitRule(write(`${cwd}/src/generated/a.ts`), rules, cwd)?.decision, 'deny');
  assert.equal(habitRule(write(`${cwd}/lib/a.ts`), rules, cwd), undefined);
  assert.equal(habitRule({ ...write(`${cwd}/src/a.ts`), paths: [`${cwd}/src/a.ts`, `${cwd}/lib/b.ts`] }, rules, cwd), undefined);
  assert.equal(habitRule({ ...write(`${cwd}/src/a.ts`), kind: 'file-read' }, rules, cwd), undefined);
  const answered = habitRule(question('项目用哪个包管理器？', '工具链'), rules, cwd);
  assert.equal(answered?.decision, 'answer');
  assert.deepEqual(answered?.answers, { '项目用哪个包管理器？': 'pnpm' });
  assert.equal(habitRule(question('要不要加测试？'), rules, cwd), undefined);
  assert.equal(habitRule({ kind: 'other', tool: 'mcp__x__y', summary: '', detail: '', paths: [], raw: {} }, rules, cwd)?.decision, 'allow');
  assert.equal(habitRule({ kind: 'network', tool: 'WebFetch', summary: '', detail: 'https://a', paths: [], raw: {} }, rules, cwd), undefined);
});

test('layer order: hard deny is final, hard escalations and writes outside the task ask the user, habits deny or answer, routine requests are allowed', () => {
  const rules = [rule({ kind: 'command', pattern: 'git push', decision: 'allow' }), rule({ kind: 'command', pattern: 'cat', decision: 'allow' }),
    rule({ kind: 'command', pattern: 'npm publish', decision: 'deny' }), rule({ kind: 'command', pattern: 'npm test', decision: 'allow' })];
  assert.equal(decideLayers(command('cat ~/.ssh/id_rsa'), roots, rules, cwd).layer, 'hard');
  const push = decideLayers(command('git push origin main'), roots, rules, cwd);
  assert.equal(push.layer, 'user');
  assert.match((push as { reason: string }).reason, /git push/);
  const publish = decideLayers(command('npm publish'), roots, rules, cwd);
  assert.equal(publish.layer, 'habit');
  assert.equal((publish as { verdict: { decision: string } }).verdict.decision, 'deny');
  assert.deepEqual(decideLayers(command('npm test'), roots, rules, cwd), { layer: 'auto' }, 'a stored allow rule no longer decides anything');
  assert.deepEqual(decideLayers(command('npm run build'), roots, rules, cwd), { layer: 'auto' });
  assert.equal(decideLayers({ ...write('/etc/hosts') }, roots, [rule({ kind: 'file-write', pattern: '/etc/**', decision: 'allow' })], cwd).layer, 'user');
  assert.deepEqual(decideLayers(write(`${cwd}/src/login.ts`), roots, [], cwd), { layer: 'auto' });
  assert.deepEqual(decideLayers(write('/home/dev/project/other/a.ts'), roots, [], cwd), { layer: 'user', reason: '写入任务目录之外：/home/dev/project/other/a.ts' },
    'inside the roots but outside the task directory: neither coder would write there on its own');
  assert.deepEqual(decideLayers({ ...write(''), paths: [] }, roots, [], cwd), { layer: 'user', reason: '改动的路径未知' });
  assert.equal(decideLayers(write(`${cwd}/.env`), roots, [], cwd).layer, 'hard');
  assert.equal(decideLayers(write(`${cwd}/dist/a.js`), roots, [rule({ kind: 'file-write', pattern: 'dist/**', decision: 'deny' })], cwd).layer, 'habit');
  assert.deepEqual(decideLayers(question('用哪个数据库？'), roots, [], cwd), { layer: 'user' });
  assert.equal(decideLayers(question('用哪个包管理器？'), roots, [rule({ kind: 'question', pattern: '包管理器', decision: 'answer', answer: 'pnpm' })], cwd).layer, 'habit');
  assert.equal(decideLayers({ kind: 'network', tool: 'WebFetch', summary: '', detail: 'https://a', paths: [], raw: {} }, roots, [], cwd).layer, 'user');
  assert.deepEqual(decideLayers({ kind: 'other', tool: 'mcp__x__y', summary: '', detail: '', paths: [], raw: {} }, roots, [], cwd), { layer: 'user' });
});

function fakeHost(answers: (questions: AskUserQuestionItem[]) => { id: string; selected: string[]; custom?: string }[]) {
  const agent = { id: 'nexus-wechat-' + '0'.repeat(32) } as unknown as Agent;
  const asked: AskUserQuestionItem[][] = [];
  const host: EscalationHost = {
    async resolveAgent() { return { agent }; },
    async ask(request) { asked.push(request.questions); return { answers: answers(request.questions) }; },
  };
  return { host, asked };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 'ct-1', coder: 'codex', description: '修复登录页', cwd, status: 'running', ownerSession: 'nexus-wechat-' + '0'.repeat(32),
    createdAt: 1, updatedAt: 1, escalations: 0, decisions: [], ...overrides };
}

test('an approval escalation offers allow and deny only', async () => {
  const hard = fakeHost(() => [{ id: 'approve', selected: ['允许'] }]);
  const outcome = await escalateToUser(hard.host, task(), command('git push'), new AbortController().signal, 'git push');
  assert.deepEqual(hard.asked[0]![0]!.options!.map(option => option.label), ['允许', '拒绝']);
  assert.deepEqual(outcome.decision, { behavior: 'allow' });
  assert.equal(outcome.record.remembered, undefined);
});

test('coder-rules blocks in project files parse leniently and are read once per task from the task directory and repo root', async () => {
  assert.equal(parseRuleLine('allow command: npm test'), undefined, 'routine requests are allowed by default; allow lines are skipped');
  assert.deepEqual(parseRuleLine('deny file-write：dist/**'), { kind: 'file-write', pattern: 'dist/**', decision: 'deny' });
  assert.deepEqual(parseRuleLine('answer question: 包管理 = pnpm'), { kind: 'question', pattern: '包管理', decision: 'answer', answer: 'pnpm' });
  assert.equal(parseRuleLine('allow question: x'), undefined);
  assert.equal(parseRuleLine('answer command: x = y'), undefined);
  assert.equal(parseRuleLine('随便写点什么'), undefined);
  const parsed = parseRuleBlocks('# Guide\n```coder-rules\nallow command: npm test\n# comment\nnonsense\ndeny command: git commit\n```\nallow command: not in block\n', 'AGENTS.md');
  assert.deepEqual(parsed.map(item => [item.source, item.pattern, item.decision, item.note]), [['project', 'git commit', 'deny', 'AGENTS.md 第 6 行']]);
  const repo = await mkdtemp(join(tmpdir(), 'nexus-habits-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await mkdir(join(repo, 'app'));
  await writeFile(join(repo, 'AGENTS.md'), '```coder-rules\ndeny command: npm publish\n```\n');
  await writeFile(join(repo, 'app', 'CLAUDE.md'), '```nexus-coder-rules\ndeny command: rm\n```\n');
  const rules = await projectRules(join(repo, 'app'), [repo]);
  assert.deepEqual(rules.map(item => [item.pattern, item.note]), [['rm', 'CLAUDE.md 第 2 行'], ['npm publish', '../AGENTS.md 第 2 行']]);
  assert.deepEqual((await projectRules(join(repo, 'app'), ['/somewhere/else'])).map(item => item.pattern), ['rm']);
  assert.deepEqual(await projectRules(join(tmpdir()), [tmpdir()]).then(items => items.filter(item => item.note?.startsWith('AGENTS'))), []);
});

function fakeDomain(): { opener: DomainOpener; rules: Map<string, HabitRule> } {
  const rules = new Map<string, HabitRule>();
  const tasks = new Map<string, TaskRecord>();
  const tableFor = (records: Map<string, unknown>) => ({
    get: (key: string) => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size; },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async delete(key: string) { return records.delete(key); },
    async update(key: string, fn: (current: unknown) => unknown) {
      const current = records.get(key);
      if (!current) throw new Error('missing-key');
      const next = structuredClone(fn(current));
      records.set(key, next);
      return next;
    },
  });
  const domain = { name: 'nexus_coders', global: undefined as never, table: (name: string) => tableFor(name === 'rules' ? rules : tasks as Map<string, unknown>), async close() {} } as unknown as CoderDomain;
  return { opener: { async open() { return domain; } }, rules };
}

test('the store keeps rules in native storage, orders user rules first, and deduplicates', async () => {
  const { opener, rules } = fakeDomain();
  const store = await CoderStore.open(opener);
  const first = await store.addRule({ kind: 'command', pattern: 'npm test', decision: 'allow', note: '跑测试不用问' });
  assert.equal(first.existed, false);
  assert.match(first.rule.id, /^cr-[0-9a-f]{8}$/);
  assert.equal(rules.size, 1);
  const again = await store.addRule({ kind: 'command', pattern: 'npm test', decision: 'allow' });
  assert.equal(again.existed, true);
  assert.equal(again.rule.id, first.rule.id);
  await store.addRule({ kind: 'command', pattern: 'git status', decision: 'allow', source: 'learned' });
  await store.addRule({ kind: 'question', pattern: '包管理', decision: 'answer', answer: 'pnpm' });
  assert.deepEqual(store.rules().map(item => [item.source, item.pattern]), [['user', 'npm test'], ['user', '包管理'], ['learned', 'git status']]);
  assert.match(describeRule(first.rule), /允许命令「npm test」（用户：跑测试不用问）/);
  assert.equal(await store.removeRule(first.rule.id), true);
  assert.equal(await store.removeRule(first.rule.id), false);
  assert.equal(store.rules().length, 2);
});
