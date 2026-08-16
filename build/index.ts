import { existsSync, rmSync, readFileSync } from "fs";
import { resolve } from "path";
import picocolors from "picocolors";
import { execSync } from "child_process";
import {
  buildTargets,
  buildOutput,
  pkgOutputNames,
  getPkgSrcRoot,
  projectPackage,
} from "./helper";

/**
 * 版本一致性守卫：根 package.json 是唯一版本源（lockstep 发版），
 * 子包版本不一致说明改了根版本但忘了跑 pnpm sync-packages，
 * 直接报错拦截，避免产出与根版本脱节的压缩包
 */
const verifyVersions = () => {
  const rootVersion = JSON.parse(
    readFileSync(projectPackage, "utf-8")
  ).version;

  for (const pkgName of buildTargets) {
    const pkgPath = resolve(getPkgSrcRoot(pkgName), "package.json");
    const version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
    if (version !== rootVersion) {
      throw new Error(
        `[${pkgName}] 版本 ${version} 与根版本 ${rootVersion} 不一致，请先运行 pnpm sync-packages`
      );
    }
  }
};

/**
 * 完整构建流程：
 * 1. 清理 dist
 * 2. Rollup bundle（bundle.ts）
 * 3. 组装产物（assemble.ts）
 * 4. 生成 tarball
 */
const main = async () => {
  console.log(picocolors.cyan("=== MsgFerry Build ===\n"));

  // 0. 版本一致性守卫（在清理 dist 之前，失败不破坏现有产物）
  verifyVersions();

  // 1. 清理旧产物
  if (existsSync(buildOutput)) {
    rmSync(buildOutput, { recursive: true, force: true });
    console.log(picocolors.gray("Cleaned dist/\n"));
  }

  // 2. Bundle（动态导入，避免顶层 await 顺序问题）
  console.log(picocolors.cyan("--- Step 1: Bundle ---"));
  const { default: runBundle } = await import("./bundle");
  await runBundle();

  // 3. Assemble
  console.log(picocolors.cyan("\n--- Step 2: Pack ---"));
  const { default: runAssemble } = await import("./pack");
  await runAssemble();

  // 4. 打包 tarball
  // 版本号读自各产物目录的 package.json（由上一步 Pack 生成），
  // 保证压缩包名与产物内实际版本一致，而非源码目录的版本
  console.log(picocolors.cyan("\n--- Step 3: Pack tarballs ---"));
  const tarResults: { outputName: string; tarName: string }[] = [];
  for (const pkgName of buildTargets) {
    const outputName = pkgOutputNames[pkgName] ?? pkgName;
    const { version } = JSON.parse(
      readFileSync(resolve(buildOutput, outputName, "package.json"), "utf-8")
    );
    const tarName = `${outputName}-v${version}`;
    execSync(`tar czf ${tarName}.tar.gz ${outputName}`, {
      stdio: "inherit",
      cwd: buildOutput,
    });
    tarResults.push({ outputName, tarName });
    console.log(picocolors.green(`Created dist/${tarName}.tar.gz`));
  }

  console.log(picocolors.cyan("\n=== Build complete ==="));
  console.log(picocolors.green("产物位于 dist/ 目录，可直接压缩分发："));
  for (const { outputName, tarName } of tarResults) {
    console.log(picocolors.gray(`  dist/${outputName}/         (解压即用)`));
    console.log(picocolors.gray(`  dist/${tarName}.tar.gz   (压缩包)`));
  }
};

main().catch((err) => {
  console.error(picocolors.red("Build failed:"), err);
  process.exit(1);
});
