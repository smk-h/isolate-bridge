import { existsSync, rmSync } from "fs";
import picocolors from "picocolors";
import { execSync } from "child_process";
import { buildTargets, buildOutput, pkgOutputNames } from "./helper";

/**
 * 完整构建流程：
 * 1. 清理 dist
 * 2. Rollup bundle（bundle.ts）
 * 3. 组装产物（assemble.ts）
 * 4. 生成 tarball
 */
const main = async () => {
  console.log(picocolors.cyan("=== MsgFerry Build ===\n"));

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
  console.log(picocolors.cyan("\n--- Step 3: Pack tarballs ---"));
  for (const pkgName of buildTargets) {
    const outputName = pkgOutputNames[pkgName] ?? pkgName;
    execSync(`tar czf ${outputName}.tar.gz ${outputName}`, {
      stdio: "inherit",
      cwd: buildOutput,
    });
    console.log(picocolors.green(`Created dist/${outputName}.tar.gz`));
  }

  console.log(picocolors.cyan("\n=== Build complete ==="));
  console.log(picocolors.green("产物位于 dist/ 目录，可直接压缩分发："));
  for (const pkgName of buildTargets) {
    const outputName = pkgOutputNames[pkgName] ?? pkgName;
    console.log(picocolors.gray(`  dist/${outputName}/         (解压即用)`));
    console.log(picocolors.gray(`  dist/${outputName}.tar.gz   (压缩包)`));
  }
};

main().catch((err) => {
  console.error(picocolors.red("Build failed:"), err);
  process.exit(1);
});
