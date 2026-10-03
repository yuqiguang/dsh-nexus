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
  return result.replace(/\\\r?\n/g, ' ');
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
  return { imports, dynamic: imports.some(item => /^(?:importlib|runpy)(?:\.|$)/.test(item.module)) || /\b(?:__import__|exec|eval)\s*\(|\bimportlib\s*\.|\bsys\s*\.\s*(?:path|meta_path)\b/.test(code) };
}

/** Match module entry points even inside an outer PowerShell or shell command. */
export function pythonModuleCommands(command: string): string[] {
  const modules = [...command.matchAll(/\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?["']?\s+(?:(?:-[IBEsSu]+|-[XW]\s+[^\s]+)\s+)*-m\s+([A-Za-z_]\w*(?:\.\w+)*)/gi)].map(match => match[1]!);
  // Common subprocess argv form. This only locates more evidence, never executes it or grants permission.
  for (const match of command.matchAll(/(?:\bsys\.executable|["'][^"'\r\n]*\bpython(?:\d+(?:\.\d+)*)?(?:\.exe)?["'])\s*,\s*["']-m["']\s*,\s*["']([A-Za-z_]\w*(?:\.\w+)*)["']/g)) modules.push(match[1]!);
  return [...new Set(modules)];
}
