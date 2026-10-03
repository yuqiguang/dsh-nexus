/** Presentation only. Keep every path in the persisted audit and outside-root checks. */
export function changeSummary(files: readonly string[]): { project: string[]; dependencies: string[]; generated: string[] } {
  const result = { project: [] as string[], dependencies: [] as string[], generated: [] as string[] };
  for (const file of files) {
    const path = file.replace(/\\/g, '/');
    if (/(?:^|\/)(?:\.venv|node_modules|\.pnpm-store)\//i.test(path)) result.dependencies.push(file);
    else if (/(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)\/|(?:^|\/)pytest-of-[^/]+\/pytest-\d+\//i.test(path)) result.generated.push(file);
    else result.project.push(file);
  }
  return result;
}
