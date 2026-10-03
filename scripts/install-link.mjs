import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const alias = 'install';
const archiveName = 'dsh-nexus.tgz';
const checksumName = 'SHA256SUMS';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)?.slice(1).map(BigInt);
const newer = (a, b) => {
  const left = version(a), right = version(b);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] > right[i]; }
  return false;
};

/** Copy a verified versioned release to the explicitly mutable installation entry.
 * The source release and every versioned tag/asset remain untouched. */
export async function syncInstallLink(client, repository, tag) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !version(tag)) throw new Error('invalid repository or release tag');
  const source = await client.release(tag);
  if (!source || source.draft || source.tag_name !== tag) throw new Error('source release must be published');
  const current = await client.release(alias);
  const previousTag = current?.body?.match(/<!-- nexus-install-source: (v\d+\.\d+\.\d+) -->/)?.[1];
  if (current && !version(previousTag ?? '')) throw new Error('install release is not managed by this script');
  if (previousTag && newer(previousTag, tag)) return { status: 'skipped-older-release', tag: previousTag };
  const filename = `dsh-nexus-${tag.slice(1)}.tgz`;
  for (const name of [filename, checksumName]) {
    if (!source.assets.some(asset => asset.name === name && asset.state === 'uploaded')) throw new Error('source assets are incomplete');
  }
  const archive = await client.download(tag, filename);
  const sums = await client.download(tag, checksumName);
  const lines = sums.toString('utf8').trim().split(/\r?\n/).map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/.exec(line));
  const entry = lines.filter(line => line?.[2] === filename);
  const sha = digest(archive);
  if (entry.length !== 1 || entry[0][1] !== sha) throw new Error('source checksum mismatch');
  const commit = await client.commit(tag);
  const files = [[archiveName, archive], [checksumName, Buffer.from(`${sha}  ${archiveName}\n`)]];
  if (current && !current.draft && previousTag === tag && files.every(([name, bytes]) =>
    current.assets.some(asset => asset.name === name && asset.size === bytes.length && asset.digest === `sha256:${digest(bytes)}`))) {
    for (const [name, bytes] of files) {
      if (digest(await client.download(alias, name)) !== digest(bytes)) throw new Error('public download checksum mismatch; retry the workflow');
    }
    return { status: 'up-to-date', tag, commit, sha256: sha, url: `https://github.com/${repository}/releases/download/install/${archiveName}` };
  }
  const body = `固定安装地址：\n\nhttps://github.com/${repository}/releases/download/install/${archiveName}\n\n当前版本：**${tag}**。源码、兼容性和完整说明见 [${tag}](https://github.com/${repository}/releases/tag/${tag})。\n\n这个入口随新版本发布更新；已有安装不会自动升级。历史版本的安装包仍保留在各自的 Release 中。安装前请核对所需 DSH 版本。\n\nSHA256：\`${sha}\`\n\n<!-- nexus-install-source: ${tag} -->\n`;
  const release = current ?? await client.create(commit, body);
  const staged = [], replaced = [], activated = [];
  const suffix = randomUUID();
  try {
    // Upload and validate both candidates before changing the public names.
    for (const [name, bytes] of files) {
      const candidate = await client.upload(release, `${name}.next-${suffix}`, bytes);
      staged.push({ name, candidate });
      if (candidate.size !== bytes.length || candidate.state !== 'uploaded' || candidate.digest !== `sha256:${digest(bytes)}`) throw new Error('uploaded asset checksum mismatch');
    }
    for (const { name, candidate } of staged) {
      const previous = release.assets.find(asset => asset.name === name);
      if (previous) { await client.rename(previous.id, `${name}.previous-${suffix}`); replaced.push(previous); }
      await client.rename(candidate.id, name); activated.push({ name, candidate });
    }
    // Only the dedicated install alias is mutable. Never force a versioned tag.
    if (current) await client.pointAlias(commit);
    await client.publish(release.id, body, tag);
  } catch (error) {
    // A failed name switch restores the previous public files. Keep candidates
    // for diagnosis if the API also refuses rollback; a rerun can finish safely.
    for (const { name, candidate } of activated.reverse()) await client.rename(candidate.id, `${name}.next-${suffix}`);
    for (const previous of replaced.reverse()) await client.rename(previous.id, previous.name);
    throw error;
  }
  // Verify the public files independently; no authorization header follows redirects.
  for (const [name, bytes] of files) {
    if (digest(await client.download(alias, name)) !== digest(bytes)) throw new Error('public download checksum mismatch; retry the workflow');
  }
  for (const previous of replaced) await client.remove(previous.id);
  return { status: 'updated', tag, commit, sha256: sha, url: `https://github.com/${repository}/releases/download/install/${archiveName}` };
}

export function githubClient(repository, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('repository and token are required');
  const base = `https://api.github.com/repos/${repository}`;
  const request = async (method, url, data) => {
    if (!['https://api.github.com', 'https://uploads.github.com'].includes(new URL(url).origin)) throw new Error('unexpected API host');
    const binary = Buffer.isBuffer(data);
    const response = await fetch(url, { method, signal: AbortSignal.timeout(60_000), headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(data === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
    }, ...(data === undefined ? {} : { body: binary ? data : JSON.stringify(data) }) });
    if (!response.ok) throw Object.assign(new Error(`GitHub ${method} failed (${response.status})`), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  };
  return {
    async release(tag) {
      try { return await request('GET', `${base}/releases/tags/${encodeURIComponent(tag)}`); }
      catch (error) {
        if (error.status !== 404) throw error;
        // A draft created before an interrupted first upload may have no tag yet.
        if (tag === alias) return (await request('GET', `${base}/releases?per_page=100`)).find(release => release.tag_name === alias);
        return undefined;
      }
    },
    async commit(tag) {
      let ref = (await request('GET', `${base}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
      for (let i = 0; ref.type === 'tag' && i < 5; i++) ref = (await request('GET', `${base}/git/tags/${ref.sha}`)).object;
      if (ref.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error('source tag does not name a commit');
      return ref.sha;
    },
    async download(tag, name) {
      const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'Cache-Control': 'no-cache' } });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        await response.body?.cancel();
        if (![404, 502, 503].includes(response.status) || attempt === 3) throw new Error(`Public asset download failed (${response.status})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    },
    create: (commit, body) => request('POST', `${base}/releases`, { tag_name: alias, target_commitish: commit, name: 'Nexus 固定安装入口', body, draft: true, prerelease: true, make_latest: 'false' }),
    upload: (release, name, bytes) => request('POST', `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, bytes),
    rename: (id, name) => request('PATCH', `${base}/releases/assets/${id}`, { name }),
    remove: id => request('DELETE', `${base}/releases/assets/${id}`),
    async pointAlias(sha) {
      try { await request('PATCH', `${base}/git/refs/tags/${alias}`, { sha, force: true }); }
      catch (error) {
        if (error.status !== 404) throw error;
        await request('POST', `${base}/git/refs`, { ref: `refs/tags/${alias}`, sha });
      }
    },
    publish: (id, body, tag) => request('PATCH', `${base}/releases/${id}`, { name: `Nexus 固定安装入口（${tag}）`, body, draft: false, prerelease: true, make_latest: 'false' }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const repository = process.env.GITHUB_REPOSITORY, tag = process.env.RELEASE_TAG;
    console.log(JSON.stringify(await syncInstallLink(githubClient(repository, process.env.GITHUB_TOKEN), repository, tag)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
