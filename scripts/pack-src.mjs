import { execSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * @file pack-src.mjs
 * @brief 生成项目最小可编译源码包（msgferry-src-v${VERSION}.tar.gz）。
 *
 * 直接遍历项目目录树收集文件（不依赖 git）：新增源码文件/子包自动入包，
 * 无需维护文件清单；只有新增「非编译内容类别」时才需往黑名单加条目。
 * 黑名单分三层：
 *   SKIP_DIR_NAMES        目录名命中即整目录跳过（任意层级，.git/node_modules 等）
 *   EXCLUDE_FILE_PATHS    精确相对路径排除（文件，/ 分隔）
 *   EXCLUDE_FILE_PATTERNS 文件名通配排除（与 .gitignore 同源的产物/临时/敏感文件）
 *
 * scripts/ 目录整体跳过，仅 SKIP_DIR_EXCEPTIONS（跳过目录的例外保留清单）入包；
 * 入包后自动裁剪各级 package.json 的 scripts 中引用了包内不存在文件的命令
 * （npm 脚本的 cwd 为该 package.json 所在目录，按此语义校验路径存在性）。
 *
 * 目标：解压后执行 pnpm install --frozen-lockfile && pnpm build 可完整跑通。
 * 输出至项目根目录（不放 dist/ 是因为 build 会先清空 dist）。
 */

/** 项目根目录（本脚本的父目录） */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 需与根版本保持一致的发布子包（与 scripts/sync-packages.mjs 同源）。
 * 源码包内 pnpm build 会执行版本一致性守卫，版本脱节时打出的包必然编译失败，
 * 因此打包前先拦截，提示先跑 pnpm sync-packages。
 */
const VERSION_SYNC_TARGETS = ["mcp-server", "worker"];

/** 目录名命中即整目录跳过（任意层级） */
const SKIP_DIR_NAMES = new Set([
  // VCS / 依赖 / 构建产物 / pnpm 存储
  ".git",
  "node_modules",
  "dist",
  ".pnpm-store",
  // 文档 / 规划 / 测试 / CI：非编译输入
  "docs",
  "plan",
  "test",
  ".cnb",
  ".github",
  // AI 助手本地配置：可能含环境相关路径
  ".claude",
  ".opencode",
  // 本地开发辅助脚本：整目录不打包，仅 SKIP_DIR_EXCEPTIONS 保留运维必需项
  "scripts",
]);

/**
 * SKIP_DIR_NAMES 的例外保留清单（相对项目根，/ 分隔）。
 * 命中跳过目录的文件默认不入包，此处列出的除外。
 * kill-node.mjs 用于终止失控的 node 进程；
 * sync-mock.mjs 是文件交换服务器仿真脚本，build 会将其拷入 mcp-server 产物。
 */
const SKIP_DIR_EXCEPTIONS = ["scripts/kill-node.mjs", "scripts/sync-mock.mjs"];

/** 精确相对路径排除（文件，/ 分隔） */
const EXCLUDE_FILE_PATHS = new Set([
  ".cnb.yml",
  ".editorconfig",
  "README.md",
  "CODEBUDDY.md",
  "LICENSE",
]);

/** 文件名通配排除（任意层级；仅支持 *.后缀 与精确名） */
const EXCLUDE_FILE_PATTERNS = [
  // 日志 / 编译缓存
  "*.log",
  "*.tsbuildinfo",
  // 生成的压缩包（防止把历史包二次打进源码包）
  "*.tar.gz",
  "*.tgz",
  "*.zip",
  // 系统杂项 / 环境变量（可能含密钥）
  ".DS_Store",
  ".env",
  ".env.local",
];

/** 判断文件名是否命中通配排除规则（仅模式层，不含精确路径层） */
const matchesExcludePattern = (name) =>
  EXCLUDE_FILE_PATTERNS.some((p) =>
    p.startsWith("*.") ? name.endsWith(p.slice(1)) : name === p
  );

/** 递归遍历目录树，返回黑名单之外的文件相对路径列表（/ 分隔） */
const walkSourceFiles = (dir, relDir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkSourceFiles(join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILE_PATHS.has(rel) || matchesExcludePattern(entry.name)) {
        continue;
      }
      out.push(rel);
    }
  }
  return out;
};

/** 版本一致性守卫：与 build/index.ts 的 verifyVersions 同规则 */
const verifyVersions = (version) => {
  for (const name of VERSION_SYNC_TARGETS) {
    const pkgPath = resolve(PROJECT_ROOT, "packages", name, "package.json");
    const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
    if (pkgVersion !== version) {
      throw new Error(
        `packages/${name} 版本 ${pkgVersion} 与根版本 ${version} 不一致，请先运行 pnpm sync-packages`
      );
    }
  }
};

/**
 * 遍历工作区源码并拷入打包目录，返回文件数。
 * SKIP_DIR_EXCEPTIONS 属于被跳过目录的内容，这里单独拷贝并校验存在性，
 * 防止清单与仓库漂移（文件被删/改名时直接报错）。
 */
const copySources = (bundleDir) => {
  const files = walkSourceFiles(PROJECT_ROOT, "");

  const missing = SKIP_DIR_EXCEPTIONS.filter(
    (f) => !existsSync(resolve(PROJECT_ROOT, f))
  );
  if (missing.length > 0) {
    throw new Error(`例外保留清单中以下文件不存在: ${missing.join(", ")}`);
  }
  files.push(...SKIP_DIR_EXCEPTIONS);

  for (const file of files) {
    const dest = join(bundleDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(PROJECT_ROOT, file), dest);
  }
  return files.length;
};

/** 递归枚举打包目录内所有 package.json（/ 分隔相对路径） */
const listPackageJsons = (dir, relDir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (rel === "package.json" || rel.endsWith("/package.json")) {
      out.push(rel);
    }
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      listPackageJsons(
        join(dir, entry.name),
        relDir ? `${relDir}/${entry.name}` : entry.name,
        out
      );
    }
  }
  return out;
};

/** 从 npm 脚本命令串中提取相对路径文件引用（如 scripts/xx.mjs、test/*.test.ts） */
const SCRIPT_FILE_REF_RE = /[\w.@/*~+-]+\.[cm]?[jt]s/g;

/**
 * 裁剪打包目录内各级 package.json 的 scripts：
 * 命令串中引用的相对路径文件（按该 package.json 所在目录解析）不存在的，
 * 整条命令移除，保证包内 npm scripts 全部可执行。
 *
 * @returns 移除的命令条数
 */
const pruneBrokenScripts = (bundleDir) => {
  let removed = 0;

  for (const rel of listPackageJsons(bundleDir, "")) {
    const pkgPath = join(bundleDir, rel);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts) continue;

    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      const fileRefs = cmd.match(SCRIPT_FILE_REF_RE) || [];
      const missingRefs = fileRefs.filter(
        (ref) => !existsSync(resolve(dirname(pkgPath), ref))
      );
      if (missingRefs.length === 0) continue;

      delete pkg.scripts[name];
      removed++;
      console.log(
        `  ${rel}: 移除 "${name}"（引用的 ${missingRefs.join(", ")} 不在包内）`
      );
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return removed;
};

/** 递归统计目录内文件数与总字节数 */
const statBundle = (dir) => {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = statBundle(fullPath);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files++;
      bytes += statSync(fullPath).size;
    }
  }
  return { files, bytes };
};

const main = () => {
  const version = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8")
  ).version;

  verifyVersions(version);

  /** 源码包目录名（与 dist 产物的 ${name}-v${version} 命名风格一致） */
  const bundleName = `msgferry-src-v${version}`;
  /** 输出压缩包路径（项目根目录） */
  const outputFile = resolve(PROJECT_ROOT, `${bundleName}.tar.gz`);
  /** 暂存目录（位于 dist/ 下，天然在黑名单内，失败残留也不进包） */
  const stagingRoot = resolve(PROJECT_ROOT, "dist", ".pack-src-tmp");
  const bundleDir = join(stagingRoot, bundleName);

  console.log("遍历工作区收集最小可编译源码...");
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  try {
    const fileCount = copySources(bundleDir);

    console.log("裁剪 package.json 中引用缺失文件的脚本命令...");
    pruneBrokenScripts(bundleDir);

    const { bytes } = statBundle(bundleDir);
    console.log(`  共 ${fileCount} 个文件，${(bytes / 1024).toFixed(1)} KB`);

    console.log("创建 tar.gz 压缩包...");
    // tar 调用方式与 build/index.ts 一致（cwd 内相对路径，避免跨 shell 路径差异）
    execSync(`tar czf ../../${bundleName}.tar.gz ${bundleName}`, {
      cwd: stagingRoot,
      stdio: "inherit",
    });

    const size = statSync(outputFile).size;
    console.log(
      `\n完成：${outputFile}（${size} 字节 = ${(size / 1024).toFixed(1)} KB）`
    );
    console.log("解压后执行以下命令即可编译：");
    console.log("  pnpm install --frozen-lockfile");
    console.log("  pnpm build");
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
};

main();
