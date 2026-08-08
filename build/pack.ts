import { resolve } from "path";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { copy, ensureDir, remove } from "fs-extra";
import picocolors from "picocolors";
import {
  buildTargets,
  nativeDeps,
  binNames,
  getPkgOutput,
  projectRoot,
} from "./helper";

interface PkgJson {
  name: string;
  version: string;
  description?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * 读取子包原始 package.json
 */
const readPkg = (pkgName: string): PkgJson => {
  const pkgPath = resolve(projectRoot, "packages", pkgName, "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
};

/**
 * 生成产物目录的精简 package.json
 * - 保留 name/version/description/bin
 * - dependencies 只保留 external 的依赖（bundle 进去的不再列出）
 * - bin 路径重写为 index.js（产物已扁平化）
 */
const genPackageJson = (pkgName: string) => {
  const pkg = readPkg(pkgName);
  const outputDir = getPkgOutput(pkgName);

  const prodDeps: Record<string, string> = {};

  // 只保留原生依赖（其他都被 bundle 了）
  for (const dep of nativeDeps) {
    if (pkg.dependencies?.[dep]) {
      prodDeps[dep] = pkg.dependencies[dep];
    }
  }
  // @modelcontextprotocol/server 也是 external
  if (pkg.dependencies?.["@modelcontextprotocol/server"]) {
    prodDeps["@modelcontextprotocol/server"] =
      pkg.dependencies["@modelcontextprotocol/server"];
  }

  // bin 命令名从 binNames 映射取，入口固定为 index.mjs
  const binCmd = binNames[pkgName];
  const bin = binCmd ? { [binCmd]: "index.mjs" } : undefined;

  const outPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: "module",
    main: "index.mjs",
    bin,
    dependencies: prodDeps,
  };

  writeFileSync(
    resolve(outputDir, "package.json"),
    JSON.stringify(outPkg, null, 2) + "\n"
  );

  console.log(picocolors.green(`[${pkgName}] Generated package.json`));
};

/**
 * 从 pnpm 的 .pnpm 目录拷贝依赖（解引用符号链接，拷贝真实文件）
 * pnpm .pnpm 目录格式: pkg@version/node_modules/pkg
 */
const copyPnpmDep = async (
  depName: string,
  pnpmDir: string,
  destModules: string
) => {
  // pnpm .pnpm 目录下包名格式: pkg@version 或 @scope+pkg@version
  const escapedName = depName.replace(/\//g, "+");
  const dirs = readdirSync(pnpmDir).filter((d) =>
    d.startsWith(`${escapedName}@`)
  );

  for (const dir of dirs) {
    const realPkgPath = resolve(pnpmDir, dir, "node_modules", depName);
    if (!existsSync(realPkgPath)) continue;

    const dest = resolve(destModules, depName);
    if (!existsSync(dest)) {
      await ensureDir(resolve(dest, ".."));
      await copy(realPkgPath, dest, { dereference: true });
      console.log(picocolors.gray(`[${depName}] Copied from .pnpm`));
    }
  }
};

/**
 * 将 external 依赖的 node_modules 拷贝到产物目录
 */
const copyNodeModules = async (pkgName: string) => {
  const outputDir = getPkgOutput(pkgName);
  const destModules = resolve(outputDir, "node_modules");
  const pnpmDir = resolve(projectRoot, "node_modules", ".pnpm");

  if (!existsSync(pnpmDir)) {
    console.warn(picocolors.yellow("node_modules/.pnpm not found"));
    return;
  }

  const pkg = readPkg(pkgName);
  const depsToCopy = Object.keys(pkg.dependencies || {}).filter(
    (dep) => !dep.startsWith("@smai-kit/")
  );

  for (const dep of depsToCopy) {
    await copyPnpmDep(dep, pnpmDir, destModules);
  }
};

/**
 * 主流程：生成 package.json -> 拷贝 node_modules
 * 注意：不清理 index.js（由 bundle 阶段生成）
 */
const assemble = async () => {
  for (const pkgName of buildTargets) {
    const outputDir = getPkgOutput(pkgName);

    // 清理旧 node_modules
    const destModules = resolve(outputDir, "node_modules");
    if (existsSync(destModules)) {
      await remove(destModules);
    }
    await ensureDir(outputDir);

    genPackageJson(pkgName);
    await copyNodeModules(pkgName);

    // 拷贝示例配置文件到产物（便于分发后直接参考）
    const exampleSrc = resolve(projectRoot, "packages", pkgName, "config.example.json");
    if (existsSync(exampleSrc)) {
      await copy(exampleSrc, resolve(outputDir, "config.example.json"));
    }

    console.log(picocolors.green(`[${pkgName}] Pack complete\n`));
  }
};

export default async function runAssemble() {
  await assemble();
}
