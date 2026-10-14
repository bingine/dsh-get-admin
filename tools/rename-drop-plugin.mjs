/**
 * 把两个插件名里的 "plugin" 去掉：
 *   dsh-cheat-engine → dsh-cheat-engine
 *   dsh-get-admin    → dsh-get-admin
 *
 * 覆盖：包名、客户端模块 id、模块文档注释里的路径、以及**目录名字符串**。
 * 跳过 node_modules / dist / ce-src / acl-recovery —— 那些是依赖或上游源码，
 * 不该被本插件的改名波及（本插件自己也有一份 node_modules 联接，改了反而有害）。
 *
 * 只改文本，不改目录（目录重命名单独做，因为要处理进程占用与联接）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["D:\\Project\\dsh-cheat-engine", "D:\\Project\\dsh-get-admin"];
const RENAMES = [
	["dsh-cheat-engine", "dsh-cheat-engine"],
	["dsh-get-admin", "dsh-get-admin"]
];
const EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
const SKIP = /\\node_modules\\|\\dist\\|\\ce-src\\|\\acl-recovery\\|\\\.cache\\/;

/** 递归收集要处理的文件。 */
function collect(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (SKIP.test(`${full}\\`)) continue;
		if (entry.isDirectory()) collect(full, out);
		else if (EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
	}
	return out;
}

let changedFiles = 0;
let totalReplacements = 0;
const detail = [];

for (const root of ROOTS) {
	for (const file of collect(root)) {
		const before = fs.readFileSync(file, "utf8");
		let after = before;
		let count = 0;
		for (const [from, to] of RENAMES) {
			const parts = after.split(from);
			if (parts.length > 1) {
				count += parts.length - 1;
				after = parts.join(to);
			}
		}
		if (after === before) continue;
		fs.writeFileSync(file, after, "utf8");
		changedFiles += 1;
		totalReplacements += count;
		detail.push(`  ${file.replace(root, path.basename(root))}  (${count} 处)`);
	}
}

console.log(`改了 ${changedFiles} 个文件，共 ${totalReplacements} 处替换`);
for (const line of detail) console.log(line);
