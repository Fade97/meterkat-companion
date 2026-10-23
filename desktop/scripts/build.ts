// Bundles the main process, preload, registration worker and window into desktop/dist; electron-builder packs that.
//   pnpm build                       (version from package.json)
//   METERKAT_VERSION=1.2.3 pnpm build
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const version = process.env.METERKAT_VERSION ?? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Version must be semver, e.g. 1.0.0");

// The CLI modules import node:sea, which Electron does not provide.
const seaShim: Plugin = { name: "sea-shim", setup: b => b.onResolve({ filter: /^node:sea$/ }, () => ({ path: join(root, "src", "sea-shim.ts") })) };

rmSync(dist, { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "register-worker": "src/register-worker.ts" },
  absWorkingDir: root, bundle: true, platform: "node", format: "cjs", target: "node22", outdir: dist, outExtension: { ".js": ".cjs" },
  external: ["electron"], plugins: [seaShim], metafile: true, logLevel: "warning",
  define: { __AI_USAGE_COMPANION_VERSION__: JSON.stringify(version) },
});
await build({
  entryPoints: ["src/renderer/app.ts"], absWorkingDir: root, bundle: true, platform: "browser", format: "iife", target: "chrome130",
  outfile: join(dist, "renderer", "app.js"), logLevel: "warning",
});
mkdirSync(join(dist, "renderer"), { recursive: true });
for (const file of ["index.html", "style.css"]) cpSync(join(root, "src", "renderer", file), join(dist, "renderer", file));

// Licence texts of the npm packages bundled into dist (Electron and Chromium ship their own next to the executable).
const packages = new Set<string>();
for (const input of Object.keys(metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
  if (match) packages.add(resolve(root, match[1]!));
}
const sections = [...packages].sort().map(dir => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: string };
  const file = readdirSync(dir).find(name => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  if (!file) throw new Error(`${pkg.name} ships no licence file; add its notice before bundling it`);
  return `${pkg.name} ${pkg.version} (${pkg.license ?? "see below"})\n\n${readFileSync(join(dir, file), "utf8").trim()}`;
});
writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), `Meterkat desktop: third-party notices\n\nElectron and Chromium: LICENSE.electron.txt and LICENSES.chromium.html in the installation folder.\n\n${sections.join(`\n\n${"=".repeat(72)}\n\n`)}\n`);
console.log(`Built desktop ${version} into ${dist}`);
