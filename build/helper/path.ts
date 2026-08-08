import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { pkgOutputNames } from "./constants";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const projectRoot = resolve(__dirname, "..", "..");

/** packages 目录 */
export const pkgRoot = resolve(projectRoot, "packages");

/** 产物总输出目录 */
export const buildOutput = resolve(projectRoot, "dist");

/** 获取子包源码目录 */
export const getPkgSrcRoot = (pkgName: string) => resolve(pkgRoot, pkgName);

/** 获取子包产物输出目录（按成果物名称命名） */
export const getPkgOutput = (pkgName: string) =>
  resolve(buildOutput, pkgOutputNames[pkgName] ?? pkgName);

/** 项目根 package.json */
export const projectPackage = resolve(projectRoot, "package.json");

/** 根 node_modules */
export const rootNodeModules = resolve(projectRoot, "node_modules");
