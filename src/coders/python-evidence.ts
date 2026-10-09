import { dirname, resolve } from 'node:path';

/** Static observations only: never import or execute the code being reviewed. */
export interface PythonImport { module: string; names: string[] }

/** Remove comments and strings while preserving newlines and statement boundaries. */
function codeOnly(source: string): string {
  let result = '', quote = '', triple = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === '\\') { result += '  '; i++; continue; }
      if (char === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
        const width = triple ? 3 : 1; result += ' '.repeat(width); i += width - 1; quote = ''; continue;
      }
      result += char === '\n' ? '\n' : ' '; continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') { result += ' '; i++; }
      result += '\n'; continue;
    }
    if (char === '"' || char === "'") {
      quote = char; triple = source.slice(i, i + 3) === char.repeat(3);
      const width = triple ? 3 : 1; result += ' '.repeat(width); i += width - 1; continue;
    }
    result += char;
  }
  return result.replace(/\\\r?\n/g, value => ' '.repeat(value.length));
}

/** Resolve only literal sys.path insert/append expressions, and a single immutable Path(__file__).resolve().parent binding.
 * These are candidate roots for collecting code, never a claim about which module Python will execute. */
export function pythonObservations(source: string, cwd: string, file?: string): { imports: PythonImport[]; dynamic: boolean; paths: string[] } {
  const code = codeOnly(source), paths = new Set<string>(), ranges: { start: number; end: number }[] = [];
  const literal = (value: string): string | undefined => {
    const match = /^(?:r)?(["'])([^"'\\\r\n]*)\1$/.exec(value.trim());
    return match?.[2];
  };
  const constants = new Map<string, string>();
  const writes = (name: string) => new RegExp(`\\b${name}\\s*(?:=(?!=)|[+*/|&^-]=|:=|:|,[^;\\n]*=|\\.[^;\\n]*=(?!=))|\\b(?:del|global|nonlocal|def|class|as|for)\\s+${name}\\b`, 'g');
  const unmodified = (name: string) => !writes(name).test(code);
  const pathImport = /(?:^|[;\n])\s*from\s+pathlib\s+import\s+Path\s*(?=$|[;\n])/.test(code) && unmodified('Path');
  const moduleImport = /(?:^|[;\n])\s*import\s+pathlib\s*(?=$|[;\n])/.test(code) && unmodified('pathlib');
  if (file && unmodified('__file__')) for (const match of code.matchAll(/^(\w+)\s*=\s*(Path|pathlib\.Path)\s*\(\s*__file__\s*\)\s*\.\s*resolve\s*\(\s*\)\s*\.\s*parent\s*$/gm)) {
    const name = match[1]!;
    const assignments = [...code.matchAll(writes(name))];
    if (assignments.length === 1 && (match[2] === 'Path' ? pathImport : moduleImport)) constants.set(name, dirname(file));
  }
  const sysBound = pythonImports(source).imports.some(item => item.module === 'sys' && !item.names.length) && unmodified('sys');
  if (sysBound) for (const match of code.matchAll(/\bsys\s*\.\s*path\s*\.\s*(insert|append)\s*\(/g)) {
    const start = match.index, argsStart = start + match[0].length;
    const lineStart = code.lastIndexOf('\n', start) + 1, statementStart = Math.max(lineStart, code.lastIndexOf(';', start) + 1);
    // A local parameter or shadowed binding in a function cannot be inferred from a top-level import.
    if (/^[ \t]/.test(code.slice(lineStart, start)) || code.slice(statementStart, start).trim()) continue;
    let end = argsStart, depth = 1;
    for (; end < code.length && depth; end++) { if (code[end] === '(') depth++; else if (code[end] === ')') depth--; }
    if (depth || end - start > 2048) continue;
    let expression = source.slice(argsStart, end - 1).trim();
    if (match[1] === 'insert') {
      if (!/^0\s*,/.test(expression)) continue;
      expression = expression.replace(/^0\s*,\s*/, '');
    }
    let path = literal(expression);
    if (path !== undefined) path = resolve(cwd, path);
    else {
      const concat = /^str\(\s*(\w+)\s*\/\s*(.+)\s*\)$/.exec(expression);
      const suffix = concat ? literal(concat[2]!) : undefined;
      if (concat && suffix !== undefined && unmodified('str') && constants.has(concat[1]!)) path = resolve(constants.get(concat[1]!)!, suffix);
    }
    if (path !== undefined) { paths.add(path); ranges.push({ start, end }); }
  }
  let remainder = source;
  for (const range of ranges.reverse()) remainder = remainder.slice(0, range.start) + ' '.repeat(range.end - range.start) + remainder.slice(range.end);
  const parsed = pythonImports(remainder);
  // Aliases and from-imports of the path object cannot use the bounded grammar above.
  const aliases = /\b(?:import\s+sys\s+as\s+\w+|from\s+sys\s+import\b)/.test(code);
  return { ...parsed, dynamic: parsed.dynamic || aliases, paths: [...paths] };
}

export function pythonImports(source: string): { imports: PythonImport[]; dynamic: boolean } {
  const code = codeOnly(source);
  const imports: PythonImport[] = [];
  for (const match of code.matchAll(/(?:^|[;:\n])\s*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^;\n]+)/g)) {
    imports.push({ module: match[1]!, names: match[2]!.replace(/[()]/g, '').split(',').map(name => name.trim().split(/\s+as\s+/)[0]!).filter(name => /^[A-Za-z_]\w*$/.test(name)) });
  }
  for (const match of code.matchAll(/(?:^|[;:\n])\s*import\s+([^;\n]+)/g)) {
    for (const name of match[1]!.split(',')) {
      const module = name.trim().split(/\s+as\s+/)[0]!;
      if (/^[A-Za-z_]\w*(?:\.\w+)*$/.test(module)) imports.push({ module, names: [] });
    }
  }
  return { imports, dynamic: imports.some(item => /^(?:importlib|runpy)(?:\.|$)/.test(item.module)) || /\b(?:__import__|exec|eval)\s*\(|\bimportlib\s*\.|\bsys\s*\.\s*(?:path|meta_path|modules)\b/.test(code) };
}

/** Match module entry points even inside an outer PowerShell or shell command. */
export function pythonModuleCommands(command: string): string[] {
  const modules = [...command.matchAll(/\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?["']?\s+(?:(?:-[IBEsSu]+|-[XW]\s+[^\s]+)\s+)*-m\s+([A-Za-z_]\w*(?:\.\w+)*)/gi)].map(match => match[1]!);
  // Common subprocess argv form. This only locates more evidence, never executes it or grants permission.
  for (const match of command.matchAll(/(?:\bsys\.executable|["'][^"'\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?["'])\s*,\s*["']-m["']\s*,\s*["']([A-Za-z_]\w*(?:\.\w+)*)["']/g)) modules.push(match[1]!);
  return [...new Set(modules)];
}
