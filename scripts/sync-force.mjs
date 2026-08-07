import { execSync } from 'node:child_process';

// 强制让本地代码与远端分支保持一致（覆盖本地所有未提交/未推送的改动）
// 用法: pnpm git-sync-force 或 npm run git-sync-force
const branch = execSync('git symbolic-ref --short HEAD').toString().trim();
execSync('git fetch origin', { stdio: 'inherit' });
execSync(`git reset --hard origin/${branch}`, { stdio: 'inherit' });
