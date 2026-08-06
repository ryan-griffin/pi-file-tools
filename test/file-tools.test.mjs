import assert from "node:assert/strict";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const temporaryRoots = new Set();
async function tempRoot() {
	const root = await mkdtemp(join(tmpdir(), "pi-file-tools-"));
	temporaryRoots.add(root);
	return root;
}
test.afterEach(async () => {
	await Promise.all(
		[...temporaryRoots].map((root) => {
			temporaryRoots.delete(root);
			return rm(root, { recursive: true, force: true });
		}),
	);
});

const { default: extension } = await import("../src/index.ts");

function captureTools() {
	const tools = new Map();
	extension({
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	});
	return tools;
}

const tools = captureTools();
const context = (cwd) => ({ cwd });
async function call(name, params, cwd) {
	return tools
		.get(name)
		.execute(
			"test",
			params,
			new AbortController().signal,
			() => {},
			context(cwd),
		);
}
async function rejects(name, params, cwd, text) {
	await assert.rejects(call(name, params, cwd), new RegExp(text, "i"));
}
async function trySymlink(target, path) {
	try {
		await symlink(target, path);
		return true;
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") return false;
		throw error;
	}
}

test("registers exact names with strict TypeBox schemas", () => {
	assert.deepEqual([...tools.keys()], ["rename", "delete", "copy", "mkdir"]);
	for (const tool of tools.values()) {
		assert.equal(typeof tool.label, "string");
		assert.equal(typeof tool.description, "string");
		assert.equal(typeof tool.promptSnippet, "string");
		assert.equal(tool.parameters.additionalProperties, false);
		for (const schema of Object.values(tool.parameters.properties)) {
			if (schema.type !== "string") continue;
			assert.equal(schema.minLength, 1);
			assert.match(schema.pattern, /u0000.*u001f.*u007f.*u0080.*u009f/i);
		}
		assert.equal(typeof tool.execute, "function");
	}
});

test("mkdir creates parents, reports existing, and rejects files", async () => {
	const root = await tempRoot();
	const first = await call("mkdir", { path: "@a/b" }, root);
	assert.equal(first.details.created, true);
	const second = await call("mkdir", { path: "a/b" }, root);
	assert.equal(second.details.created, false);
	await writeFile(join(root, "file"), "x");
	await rejects("mkdir", { path: "file" }, root, "not a directory");
	await rejects(
		"mkdir",
		{ path: "missing/child", recursive: false },
		root,
		"ENOENT",
	);
});

test("rename moves files and directories and guards destinations", async () => {
	const root = await tempRoot();
	await writeFile(join(root, "one"), "one");
	const result = await call(
		"rename",
		{ source: "one", destination: "two" },
		root,
	);
	assert.match(result.content[0].text, /Renamed/);
	assert.equal(await readFile(join(root, "two"), "utf8"), "one");
	await writeFile(join(root, "existing"), "old");
	await rejects(
		"rename",
		{ source: "two", destination: "existing" },
		root,
		"already exists",
	);
	await call(
		"rename",
		{ source: "two", destination: "existing", overwrite: true },
		root,
	);
	assert.equal(await readFile(join(root, "existing"), "utf8"), "one");
	await mkdir(join(root, "dir", "child"), { recursive: true });
	await rejects(
		"rename",
		{ source: "dir", destination: "dir/child/nested" },
		root,
		"own descendant",
	);
	await mkdir(join(root, "ancestor", "nested"), { recursive: true });
	await rejects(
		"rename",
		{ source: "ancestor/nested", destination: "ancestor", overwrite: true },
		root,
		"ancestor",
	);
	await rejects(
		"rename",
		{ source: "existing", destination: "existing" },
		root,
		"must differ",
	);
});

test("rename overwrite preserves the destination when a cross-device move fails", async () => {
	let sourceRoot;
	try {
		sourceRoot = await mkdtemp(join("/dev/shm", "pi-file-tools-"));
	} catch (error) {
		if (
			error.code === "ENOENT" ||
			error.code === "EACCES" ||
			error.code === "EPERM"
		)
			return;
		throw error;
	}
	temporaryRoots.add(sourceRoot);
	const destinationRoot = await tempRoot();
	if ((await stat(sourceRoot)).dev === (await stat(destinationRoot)).dev)
		return;

	const source = join(sourceRoot, "source");
	const destination = join(destinationRoot, "destination");
	await writeFile(source, "new");
	await writeFile(destination, "old");
	await assert.rejects(
		call("rename", { source, destination, overwrite: true }, destinationRoot),
		(error) => error.code === "EXDEV",
	);
	assert.equal(await readFile(source, "utf8"), "new");
	assert.equal(await readFile(destination, "utf8"), "old");
});

test("delete handles files, links, empty/non-empty directories, and protections", async () => {
	const root = await tempRoot();
	await writeFile(join(root, "file"), "x");
	await call("delete", { path: "@file" }, root);
	await mkdir(join(root, "empty"));
	await call("delete", { path: "empty" }, root);
	await mkdir(join(root, "full"));
	await writeFile(join(root, "full", "x"), "x");
	await rejects("delete", { path: "full" }, root, "not empty");
	await call("delete", { path: "full", recursive: true }, root);
	await writeFile(join(root, "target"), "x");
	if (await trySymlink("target", join(root, "link"))) {
		await call("delete", { path: "link" }, root);
		await stat(join(root, "target"));
	}
	await rejects("delete", { path: root }, root, "active working directory");
	await rejects("delete", { path: homedir() }, root, "home directory");
	await rejects("delete", { path: "/" }, root, "filesystem root");
	await rejects("delete", { path: "" }, root, "non-empty");
	await rejects("delete", { path: "bad\npath" }, root, "control characters");
	await rejects(
		"delete",
		{ path: "bad\u0080path" },
		root,
		"control characters",
	);
});

test("delete refuses an ancestor containing the active cwd", async () => {
	const parent = await tempRoot();
	const child = join(parent, "child");
	await mkdir(child);
	await rejects("delete", { path: "..", recursive: true }, child, "ancestor");
	assert.equal((await stat(parent)).isDirectory(), true);
	assert.equal((await stat(child)).isDirectory(), true);
});

test("copy preserves directory and regular-file permission bits", async () => {
	const root = await tempRoot();
	const source = join(root, "source");
	await mkdir(join(source, "nested"), { recursive: true });
	await writeFile(join(source, "nested", "file"), "content");
	await chmod(source, 0o700);
	await chmod(join(source, "nested"), 0o751);
	await chmod(join(source, "nested", "file"), 0o640);
	await call(
		"copy",
		{ source: "source", destination: "copy", recursive: true },
		root,
	);
	assert.equal((await stat(join(root, "copy"))).mode & 0o7777, 0o700);
	assert.equal((await stat(join(root, "copy", "nested"))).mode & 0o7777, 0o751);
	assert.equal(
		(await stat(join(root, "copy", "nested", "file"))).mode & 0o7777,
		0o640,
	);
});

test("copy handles files, directories, symlinks, recursive and overwrite guards", async () => {
	const root = await tempRoot();
	await writeFile(join(root, "file"), "hello");
	await call("copy", { source: "file", destination: "copy" }, root);
	assert.equal(await readFile(join(root, "copy"), "utf8"), "hello");
	await rejects(
		"copy",
		{ source: "file", destination: "copy" },
		root,
		"already exists",
	);
	await call(
		"copy",
		{ source: "file", destination: "copy", overwrite: true },
		root,
	);
	await mkdir(join(root, "dir"));
	await writeFile(join(root, "dir", "nested"), "nested");
	await rejects(
		"copy",
		{ source: "dir", destination: "dir-copy" },
		root,
		"requires recursive",
	);
	await call(
		"copy",
		{ source: "dir", destination: "dir-copy", recursive: true },
		root,
	);
	assert.equal(
		await readFile(join(root, "dir-copy", "nested"), "utf8"),
		"nested",
	);
	await rejects(
		"copy",
		{ source: "dir", destination: "dir/nested/new", recursive: true },
		root,
		"own descendant",
	);
	await rejects(
		"copy",
		{
			source: "dir/nested",
			destination: "dir",
			recursive: true,
			overwrite: true,
		},
		root,
		"ancestor",
	);
	if (await trySymlink("file", join(root, "source-link"))) {
		await call(
			"copy",
			{ source: "source-link", destination: "copied-link" },
			root,
		);
		assert.equal(await readlink(join(root, "copied-link")), "file");
		assert.equal((await stat(join(root, "copied-link"))).isFile(), true);
	}
});

test("ancestor locks prevent a queued copy from following a renamed symlink parent", async () => {
	const root = await tempRoot();
	await mkdir(join(root, "victim"));
	await writeFile(join(root, "victim", "file"), "old");
	await writeFile(join(root, "source"), "new");
	if (!(await trySymlink("victim", join(root, "link")))) return;

	let releaseHeldLock;
	const held = new Promise((resolve) => {
		releaseHeldLock = resolve;
	});
	let enteredResolve;
	const entered = new Promise((resolve) => {
		enteredResolve = resolve;
	});
	const hold = withFileMutationQueue(join(root, "dest"), async () => {
		enteredResolve();
		await held;
	});
	await entered;

	// Queue rename first while dest is absent, then queue copy behind it. Once
	// rename turns dest into a symlink, copy must reject rather than follow it.
	const rename = call(
		"rename",
		{ source: "link", destination: "dest", overwrite: true },
		root,
	);
	await new Promise((resolve) => setImmediate(resolve));
	const copy = call(
		"copy",
		{ source: "source", destination: "dest/file" },
		root,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await readFile(join(root, "victim", "file"), "utf8"), "old");

	releaseHeldLock();
	await Promise.all([hold, rename]);
	await assert.rejects(
		copy,
		/destination changed.*refusing to follow redirected path/i,
	);
	assert.equal(await readFile(join(root, "victim", "file"), "utf8"), "old");
	assert.equal(await readlink(join(root, "dest")), "victim");
});

test("concurrent mutation calls serialize on the same path", async () => {
	const root = await tempRoot();
	const results = await Promise.all([
		call("mkdir", { path: "same" }, root),
		call("mkdir", { path: "same" }, root),
	]);
	assert.equal(results.filter((result) => result.details.created).length, 1);
	assert.equal(results.filter((result) => !result.details.created).length, 1);
});

test("symlinked directory sources and parents cannot bypass descendant protection", async () => {
	const root = await tempRoot();
	await mkdir(join(root, "source"));
	const sourceLink = join(root, "source-link");
	const parentLink = join(root, "parent-link");
	if (!(await trySymlink("source", sourceLink))) return;
	if (!(await trySymlink("source", parentLink))) return;
	await rejects(
		"copy",
		{
			source: "source-link",
			destination: "source-link/child",
			recursive: true,
		},
		root,
		"own descendant",
	);
	await rejects(
		"rename",
		{ source: "source", destination: "parent-link/child" },
		root,
		"own descendant",
	);
});

test("canonical mutation aliases settle without a queue deadlock", async () => {
	const root = await tempRoot();
	await mkdir(join(root, "a"));
	if (!(await trySymlink("a", join(root, "z")))) return;
	await assert.rejects(
		Promise.race([
			call("rename", { source: "a", destination: "z", overwrite: true }, root),
			new Promise((_, reject) => {
				const timer = setTimeout(
					() => reject(new Error("mutation queue deadlocked")),
					1000,
				);
				timer.unref?.();
			}),
		]),
		/source and destination must differ/i,
	);
});

test("active cwd protection follows real paths but permits unlinking its alias", async () => {
	const root = await tempRoot();
	const cwdAlias = join(root, "cwd-alias");
	if (!(await trySymlink(root, cwdAlias))) return;
	await rejects("delete", { path: root }, cwdAlias, "active working directory");
	await call("delete", { path: "cwd-alias" }, root);
});

test("rename and copy refuse to overwrite protected destinations", async () => {
	const root = await tempRoot();
	const cwd = join(root, "cwd");
	const source = join(root, "source");
	await mkdir(cwd, { recursive: true });
	await writeFile(source, "x");
	await writeFile(join(cwd, "work"), "work");

	// The active working directory itself.
	await rejects(
		"rename",
		{ source, destination: cwd, overwrite: true },
		cwd,
		"active working directory",
	);
	await rejects(
		"copy",
		{ source, destination: cwd, overwrite: true },
		cwd,
		"active working directory",
	);
	// An ancestor holding the active working directory.
	await rejects(
		"rename",
		{ source, destination: root, overwrite: true },
		cwd,
		"ancestor",
	);
	await rejects(
		"copy",
		{ source, destination: root, overwrite: true },
		cwd,
		"ancestor",
	);
	// The home directory and an ancestor of it.
	await rejects(
		"rename",
		{ source, destination: homedir(), overwrite: true },
		root,
		"home directory",
	);
	await rejects(
		"copy",
		{ source, destination: homedir(), overwrite: true },
		root,
		"home directory",
	);
	await rejects(
		"rename",
		{ source, destination: join(homedir(), ".."), overwrite: true },
		root,
		"ancestor of the home",
	);
	// Refusals leave both the source and the protected destination untouched.
	assert.equal(await readFile(source, "utf8"), "x");
	assert.equal(await readFile(join(cwd, "work"), "utf8"), "work");

	// Overwriting a symlink that points at the active cwd stays allowed: the
	// swap replaces the link only, leaving the real directory intact.
	const cwdAlias = join(root, "cwd-alias");
	if (await trySymlink(cwd, cwdAlias)) {
		await call(
			"rename",
			{ source, destination: cwdAlias, overwrite: true },
			root,
		);
		assert.equal(await readFile(join(cwd, "work"), "utf8"), "work");
		assert.equal((await lstat(cwdAlias)).isFile(), true);
	}
});

test("copy staging preserves an existing destination when a socket cannot be copied", async () => {
	const root = await tempRoot();
	await mkdir(join(root, "source"));
	await writeFile(join(root, "destination"), "old");
	const socketPath = join(root, "source", "unsupported-socket");
	const server = createServer();
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		await assert.rejects(
			call(
				"copy",
				{
					source: "source",
					destination: "destination",
					recursive: true,
					overwrite: true,
				},
				root,
			),
		);
		assert.equal(await readFile(join(root, "destination"), "utf8"), "old");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("missing sources and destination parents remain errors", async () => {
	const root = await tempRoot();
	await rejects(
		"rename",
		{ source: "missing", destination: "new" },
		root,
		"ENOENT",
	);
	await rejects(
		"copy",
		{ source: "missing", destination: "new" },
		root,
		"ENOENT",
	);
	await writeFile(join(root, "source"), "x");
	await rejects(
		"copy",
		{ source: "source", destination: "missing/new" },
		root,
		"ENOENT",
	);
});
