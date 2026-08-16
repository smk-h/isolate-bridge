import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 需与根版本保持一致的发布子包（packages/ 下的目录名）。
 * 只有它们的版本会进入产物（pack.ts 读取后写入 dist 并用于压缩包命名）；
 * shared 被 bundle 内联、build 是构建工具，均不发布，不参与同步。
 */
const syncTargets = ["mcp-server", "worker"];

/** 仅内容变化时才写入，避免无意义的文件改动污染 git status */
const writeIfChanged = (target, content) => {
  if (existsSync(target) && readFileSync(target, "utf-8") === content) {
    return false;
  }
  writeFileSync(target, content);
  return true;
};

const rootVersion = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf-8")
).version;

let changed = 0;
for (const name of syncTargets) {
  const pkgPath = resolve(root, "packages", name, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  if (pkg.version === rootVersion) continue;
  const oldVersion = pkg.version;
  pkg.version = rootVersion;

  if (writeIfChanged(pkgPath, JSON.stringify(pkg, null, 2) + "\n")) {
    changed++;
    console.log(`packages/${name}/package.json: ${oldVersion} -> ${rootVersion}`);
  }
}

if (changed === 0) {
  console.log(`All package versions already in sync at ${rootVersion}.`);
} else {
  console.log(`Synced ${changed} package(s) to v${rootVersion}.`);
}
