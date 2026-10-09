/** Presentation only. Keep every path in the persisted audit and outside-root checks. */
export function changeSummary(files: readonly string[], declared: readonly string[] = []): { project: string[]; dependencies: string[]; generated: string[] } {
  const result = { project: [] as string[], dependencies: [] as string[], generated: [] as string[] };
  const normalized = (file: string) => file.replace(/\\/g, '/');
  const preferred = new Set(declared.map(normalized));
  for (const file of files) {
    const path = normalized(file);
    if (preferred.has(path)) result.project.push(file);
    else if (/(?:^|\/)(?:\.venv|node_modules|\.pnpm-store|pydeps|site-packages)\//i.test(path)) result.dependencies.push(file);
    else if (/(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.pip-cache|\.npm-cache)\/|(?:^|\/)pytest-of-[^/]+\/pytest-\d+\//i.test(path)) result.generated.push(file);
    else result.project.push(file);
  }
  const priority = (file: string) => preferred.has(normalized(file)) ? -1
    : /\.(?:md|mdx|[cm]?[jt]sx?|py|ps1|sh|rs|go|java|html?|css|toml|ya?ml)$/i.test(file) ? 0
    : /\.(?:json|txt|csv|pdf|zip|mp4|webm|mov|mp3|wav|m4a|ogg)$/i.test(file) ? 1 : 2;
  // Keep all project paths, including numbered image sequences; source, reports and declared outputs come first.
  result.project.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  return result;
}
