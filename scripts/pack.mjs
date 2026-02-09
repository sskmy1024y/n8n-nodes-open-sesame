/**
 * n8n デプロイ用の tar.gz を作成するスクリプト
 *
 * 含まれるもの:
 *   - dist/          (ビルド済みJS + SVGアイコン)
 *   - package.json   (n8n がノードを認識するために必要)
 *
 * リモート側での手順:
 *   tar xzf n8n-nodes-open-sesame-<version>.tar.gz
 *   cd n8n-nodes-open-sesame
 *   npm install --omit=dev
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outName = `${pkg.name}-${pkg.version}.tar.gz`;

execSync(
	`tar czf ${outName} dist/ package.json`,
	{ cwd: root, stdio: 'inherit' },
);

console.log(`\n✓ ${outName} を作成しました`);
console.log(`\nリモートでの展開手順:`);
console.log(`  mkdir n8n-nodes-open-sesame && tar xzf ${outName} -C n8n-nodes-open-sesame`);
console.log(`  cd n8n-nodes-open-sesame && npm install --omit=dev`);
