import { resolve } from "path";
import { rollup } from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";
import esbuild from "rollup-plugin-esbuild";
import picocolors from "picocolors";
import {
  buildTargets,
  external,
  target,
  getPkgSrcRoot,
  getPkgOutput,
} from "./helper";

/**
 * 构建单个子包：将 TS 源码 bundle 成单文件 ESM
 * workspace 依赖（@smai-kit/*）的 main 指向 src/index.ts，
 * nodeResolve 配合 extensions: [".ts"] 可直接解析源码并内联
 */
const buildPackage = async (pkgName: string) => {
  const srcRoot = getPkgSrcRoot(pkgName);
  const outputDir = getPkgOutput(pkgName);
  const input = resolve(srcRoot, "src/index.ts");

  console.log(picocolors.cyan(`[${pkgName}] Starting bundle...`));

  const bundle = await rollup({
    input,
    plugins: [
      nodeResolve({
        extensions: [".js", ".ts"],
        preferBuiltins: true,
      }),
      commonjs(),
      json(),
      esbuild({
        target,
        platform: "node",
      }),
    ],
    external,
    treeshake: true,
  });

  await bundle.write({
    format: "esm",
    file: resolve(outputDir, "index.mjs"),
    sourcemap: false,
    exports: "auto",
    banner: "#!/usr/bin/env node\n",
  });

  await bundle.close();

  console.log(picocolors.green(`[${pkgName}] Successfully bundled`));
};

/**
 * 遍历所有目标包执行构建
 */
export default async function runBundle() {
  for (const pkgName of buildTargets) {
    await buildPackage(pkgName);
  }
}
