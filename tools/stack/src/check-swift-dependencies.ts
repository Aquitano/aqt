import { appendFile } from "node:fs/promises";

import { type } from "arktype";

const manifest = type({
  "packages?": { "[string]": { "url?": "string", "exactVersion?": "string", "from?": "string" } },
});
const githubRelease = type({ tag_name: "string", html_url: "string.url" });
const headers = new Headers({ Accept: "application/vnd.github+json" });
if (process.env.GITHUB_TOKEN) headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);

const paths = Array.from(new Bun.Glob("apps/*/project.yml").scanSync("."));
const manifests = await Promise.all(
  paths.map(async (path) => {
    const document: unknown = Bun.YAML.parse(await Bun.file(path).text());
    return { path, project: manifest.assert(document) };
  }),
);
const dependencies = manifests.flatMap(({ path, project }) =>
  Object.entries(project.packages ?? {}).map(([name, dependency]) => ({ path, name, dependency })),
);
const results = await Promise.all(
  dependencies.map(async ({ path, name, dependency }) => {
    const pinned = dependency.exactVersion ?? dependency.from;
    if (!dependency.url || !pinned) return null;
    const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      dependency.url,
    )?.[1];
    if (!repository) throw new Error(`Unsupported release source for ${name} in ${path}`);
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers,
    });
    if (!response.ok) throw new Error(`${name}: GitHub returned ${response.status}`);
    const body: unknown = await response.json();
    const release = githubRelease.assert(body);
    const latest = release.tag_name.replace(/^v/, "");
    const outdated = Bun.semver.satisfies(latest, `>${pinned}`);
    if (outdated)
      console.log(
        `::warning file=${path}::${name} ${latest} is available; review the ${pinned} pin`,
      );
    return { outdated, row: `| ${path}: ${name} | ${pinned} | [${latest}](${release.html_url}) |` };
  }),
);
const rows = results.flatMap((result) => (result ? [result.row] : []));
const report = [
  "# Swift dependency versions",
  "",
  "| Dependency | Pinned | Latest stable |",
  "| --- | --- | --- |",
  ...rows,
  "",
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
if (results.some((result) => result?.outdated)) process.exitCode = 1;
