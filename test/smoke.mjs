import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceFiles = [
	"src/index.ts",
	"src/paths.ts",
	"src/tools/rename.ts",
	"src/tools/delete.ts",
	"src/tools/copy.ts",
	"src/tools/mkdir.ts",
	"src/shared.ts",
];
function readSource(file) {
	try {
		return readFileSync(resolve(root, file), "utf8");
	} catch {
		return "";
	}
}
const source = sourceFiles.map(readSource).join("\n");
let packageJson;
try {
	packageJson = JSON.parse(readSource("package.json"));
} catch {
	assert.fail("package.json is missing or invalid JSON");
}

for (const file of sourceFiles)
	assert.ok(readSource(file).length > 0, `${file} exists`);
assert.deepEqual(packageJson.pi.extensions, ["./src/index.ts"]);
assert.equal(packageJson.main, "./src/index.ts");
assert.equal(packageJson.exports["."], "./src/index.ts");
for (const name of ["rename", "delete", "copy", "mkdir"]) {
	assert.equal(
		(source.match(new RegExp(`name: \\"${name}\\"`, "g")) ?? []).length,
		1,
		`${name} appears once`,
	);
}
assert.equal((source.match(/registerTool\(/g) ?? []).length, 4);
assert.equal((source.match(/additionalProperties:\s*false/g) ?? []).length, 4);
assert.equal((source.match(/promptSnippet:/g) ?? []).length, 4);
assert.ok(source.includes('from "typebox"'));
assert.ok(source.includes("withFileMutationQueue"));
assert.ok(source.includes('from "node:fs/promises"'));
assert.ok(!source.includes("child_process"));
assert.ok(!source.includes("shell:"));
assert.ok(!source.includes("exec("));
console.log(
	"pi-file-tools smoke tests passed: 4 tools, strict schemas, manifest, queue, and no shell execution",
);
