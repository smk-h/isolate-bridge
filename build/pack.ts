import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { copy, ensureDir, remove } from "fs-extra";
import picocolors from "picocolors";
import walk from "ignore-walk";
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

/** npm 发布时永不进包的保留文件（无论如何 .npmignore 都收不进去） */
const ALWAYS_INCLUDED = ["package.json", "README.md", "LICENSE", "LICENCE", "NOTICE"];

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
 * pnpm .pnpm 目录格式: pkg@version/node_modules/<name>，
 * 同目录下还包含该包的全部传递依赖符号链接，一并解引用拷贝。
 *
 * 传递依赖自身还可能有子依赖（如 asn1 -> safer-buffer），
 * 这些住在各自独立的虚拟根里，因此需递归处理，防止产物缺失运行时依赖。
 * 用 visited 集合按包名去重，避免版本冲突时重复拷贝覆盖。
 */
const copyPnpmDep = async (
  depName: string,
  pnpmDir: string,
  destModules: string,
  visited: Set<string> = new Set()
) => {
  if (visited.has(depName)) return;
  visited.add(depName);

  // pnpm .pnpm 目录下包名格式: pkg@version 或 @scope+pkg@version
  const escapedName = depName.replace(/\//g, "+");
  const dirs = readdirSync(pnpmDir).filter((d) =>
    d.startsWith(`${escapedName}@`)
  );

  for (const dir of dirs) {
    const virtualRoot = resolve(pnpmDir, dir, "node_modules");
    if (!existsSync(virtualRoot)) continue;

    // 拷贝该包及其全部依赖（虚拟 store 顶层的符号链接）
    const entries = readdirSync(virtualRoot);
    for (const entry of entries) {
      const src = resolve(virtualRoot, entry);
      const dest = resolve(destModules, entry);
      if (!existsSync(dest)) {
        await ensureDir(resolve(dest, ".."));
        await copy(src, dest, { dereference: true });
        console.log(picocolors.gray(`[${entry}] Copied from .pnpm`));
      }

      // 递归拷贝子依赖的虚拟根；entry 为包自身时跳过
      if (entry !== depName) {
        await copyPnpmDep(entry, pnpmDir, destModules, visited);
      }
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
 * 读取子包 .npmignore（与 npm 发布同源规则），无则返回 null
 */
const readNpmIgnore = (pkgName: string): string | null => {
  const igPath = resolve(projectRoot, "packages", pkgName, ".npmignore");
  return existsSync(igPath) ? readFileSync(igPath, "utf-8") : null;
};

/**
 * 依据 .npmignore 将子包内「需要分发」的文件递归拷贝到产物目录。
 * 规则与 npm pack / npm publish 完全一致（ignore-walk 即 npm-packlist 底层），
 * 因此「离线 tar.gz 里有什么」≈「npm 线上包里有什么」。
 */
const copyFilesByNpmIgnore = async (pkgName: string) => {
  const pkgSrc = resolve(projectRoot, "packages", pkgName);
  const outputDir = getPkgOutput(pkgName);

  const ignoreContent = readNpmIgnore(pkgName);
  const ignoreFiles = ignoreContent ? [".npmignore"] : undefined;

  // 文件列表来自子包目录本身，不把产物目录/兄弟目录扫进来
  const files = await walk({
    path: pkgSrc,
    ignoreFiles,
    follow: true,
  });

  for (const rel of files) {
    // 排除 npm 无条件保留的文件（与发布语义一致，产物自己会生成）
    if (ALWAYS_INCLUDED.includes(rel)) continue;
    // 排除 .npmignore 本身（它只是规则文件，不进入产物）
    if (rel === ".npmignore") continue;

    const src = resolve(pkgSrc, rel);
    const dest = resolve(outputDir, rel);

    // 保险：walk 只会返回文件，目录本身不需要创建（copy 会自动建父目录）
    if (!statSync(src).isFile()) continue;

    await ensureDir(dirname(dest));
    await copy(src, dest);
    console.log(picocolors.gray(`[${pkgName}] copied ${rel}`));
  }
};

/**
 * 校验 .npmignore 中「取反声明」的路径在源目录真实存在。
 * 这是白名单式清单（`!foo.json`）的核心保障：声明了要分发却不存在，直接报错而不是静默跳过。
 * 普通的排除规则（黑名单）不校验——排除一个不存在的路径是安全的。
 */
const verifyNpmIgnore = (pkgName: string) => {
  const content = readNpmIgnore(pkgName);
  if (!content) return;

  const pkgSrc = resolve(projectRoot, "packages", pkgName);
  const rules = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const missing: string[] = [];
  for (const rule of rules) {
    if (!rule.startsWith("!")) continue; // 只校验取反规则
    const pattern = rule.slice(1).replace(/\/+$/, "");
    if (!pattern) continue;
    // 含通配符的取反无法可靠静态判定，跳过
    if (/[*?\[\]{}]/.test(pattern)) continue;

    if (!existsSync(resolve(pkgSrc, pattern))) {
      missing.push(rule);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      picocolors.red(
        `[${pkgName}] .npmignore 中取反声明的路径不存在: ${missing.join(", ")}`
      )
    );
  }
};

/**
 * 将项目根目录 scripts/ 下的共享脚本拷贝进产物目录。
 * 这些脚本不属于任何子包目录，因此不走 .npmignore 白名单，这里单独处理。
 * 拷贝后随产物一起压缩分发，保证部署解压即用。
 */
const copyExtraScripts = async (outputDir: string) => {
  const extraScripts = ["sync-mock.mjs"];
  const scriptsSrc = resolve(projectRoot, "scripts");

  for (const file of extraScripts) {
    const src = resolve(scriptsSrc, file);
    if (!existsSync(src)) {
      console.warn(
        picocolors.yellow(`[mcp-server] extra script not found: scripts/${file}`)
      );
      continue;
    }
    const dest = resolve(outputDir, "scripts", file);
    await ensureDir(dirname(dest));
    await copy(src, dest);
    console.log(
      picocolors.gray(`[mcp-server] copied scripts/${file} -> ${dest}`)
    );
  }
};

/**
 * 主流程：生成 package.json -> 拷贝 node_modules -> 按 .npmignore 拷贝分发文件
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

    // 打包前校验 .npmignore 规则引用的路径都存在
    verifyNpmIgnore(pkgName);

    genPackageJson(pkgName);
    await copyNodeModules(pkgName);

    // 按 .npmignore 拷贝分发文件（config.example.json、.mcp.json、.claude/... 等
    // 都在各自的 .npmignore 白名单式清单里声明，新增文件无需再改 build）
    await copyFilesByNpmIgnore(pkgName);

    // 拷贝根目录共享脚本（位于项目 scripts/，不属于任何子包）
    // sync-mock.mjs 是文件交换服务器的测试/仿真脚本，部署后可直接调用，
    // 因此需一并随 mcp-server 产物分发并压缩。
    if (pkgName === "mcp-server") {
      await copyExtraScripts(outputDir);
    }

    console.log(picocolors.green(`[${pkgName}] Pack complete\n`));
  }
};

export default async function runAssemble() {
  await assemble();
}
