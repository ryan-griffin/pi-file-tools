import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mock, test } from "node:test";
import extension from "../src/index.ts";

const tools = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool) });
const roots = [];
const originalRename = fs.rename;
const originalCopyFile = fs.copyFile;
const originalRm = fs.rm;
const originalMkdtemp = fs.mkdtemp;

function patch(name, implementation) {
	mock.method(fs, name, implementation);
	syncBuiltinESMExports();
}

function ioError(code) {
	return Object.assign(new Error(`injected ${code}`), { code });
}

// Fault injection exercises each failure phase even on single-device hosts.
// file-tools.test.mjs also covers a real /dev/shm -> tmpdir EXDEV.
async function fixture(overwrite = true) {
	const root = await fs.mkdtemp(join(tmpdir(), "pi-move-test-"));
	roots.push(root);
	const source = join(root, "source");
	const destination = join(root, "destination");
	const controller = new AbortController();
	patch("rename", async (from, to) => {
		if (from === source && to === destination) throw ioError("EXDEV");
		return originalRename(from, to);
	});
	return {
		root,
		source,
		destination,
		controller,
		move: () =>
			tools
				.get("rename")
				.execute(
					"test",
					{ source, destination, overwrite },
					controller.signal,
					() => {},
					{ cwd: root },
				),
	};
}

test.afterEach(async () => {
	mock.restoreAll();
	syncBuiltinESMExports();
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

async function assertOriginals(f) {
	assert.equal(await fs.readFile(f.source, "utf8"), "new");
	assert.equal(await fs.readFile(f.destination, "utf8"), "old");
	assert.deepEqual((await fs.readdir(f.root)).sort(), [
		"destination",
		"source",
	]);
}

test("cross-device directory moves preserve modes and symlinks", async () => {
	for (const overwrite of [false, true]) {
		const f = await fixture(overwrite);
		await fs.mkdir(join(f.source, "nested"), { recursive: true });
		await fs.writeFile(join(f.source, "nested", "file"), "content");
		await fs.chmod(f.source, 0o750);
		await fs.chmod(join(f.source, "nested"), 0o751);
		await fs.chmod(join(f.source, "nested", "file"), 0o640);
		await fs.symlink("nested/file", join(f.source, "link"));
		await fs.symlink("missing", join(f.source, "dangling"));
		if (overwrite) {
			await fs.mkdir(f.destination);
			await fs.writeFile(join(f.destination, "old"), "old");
		}
		const result = await f.move();
		assert.equal(result.details.kind, "directory");
		assert.equal(
			await fs.readFile(join(f.destination, "link"), "utf8"),
			"content",
		);
		assert.equal(await fs.readlink(join(f.destination, "link")), "nested/file");
		assert.equal(await fs.readlink(join(f.destination, "dangling")), "missing");
		for (const [path, mode] of [
			["", 0o750],
			["nested", 0o751],
			["nested/file", 0o640],
		]) {
			assert.equal(
				(await fs.stat(join(f.destination, path))).mode & 0o7777,
				mode,
			);
		}
		await assert.rejects(fs.lstat(f.source), { code: "ENOENT" });
		await assert.rejects(fs.lstat(join(f.destination, "old")), {
			code: "ENOENT",
		});
		assert.deepEqual(await fs.readdir(f.root), ["destination"]);
	}
});

test("cross-device moves preserve a top-level dangling symlink", async () => {
	const f = await fixture();
	await fs.symlink("missing", f.source);
	await fs.writeFile(f.destination, "old");
	await f.move();
	assert.equal(await fs.readlink(f.destination), "missing");
	await assert.rejects(fs.lstat(f.source), { code: "ENOENT" });
	assert.deepEqual(await fs.readdir(f.root), ["destination"]);
});

test("failed staging preserves both originals and removes the partial copy", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	patch("copyFile", async (_source, destination) => {
		await fs.writeFile(destination, "partial");
		throw ioError("ENOSPC");
	});
	await assert.rejects(f.move(), { code: "ENOSPC" });
	await assertOriginals(f);
});

test("abort during staging preserves both originals and cleans up", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	patch("copyFile", async (...args) => {
		await originalCopyFile(...args);
		f.controller.abort();
	});
	await assert.rejects(f.move(), /Operation aborted/);
	await assertOriginals(f);
});

test("abort after allocating a temporary directory still cleans it up", async () => {
	for (const prefix of [".pi-file-tools-rename-", ".pi-file-tools-move-"]) {
		const f = await fixture();
		await fs.writeFile(f.source, "new");
		await fs.writeFile(f.destination, "old");
		patch("mkdtemp", async (path) => {
			const directory = await originalMkdtemp(path);
			if (basename(path).startsWith(prefix)) f.controller.abort();
			return directory;
		});
		await assert.rejects(f.move(), /Operation aborted/);
		await assertOriginals(f);
	}
});

test("failed publication restores the overwritten destination", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	patch("rename", async (from, to) => {
		if (from === f.source) throw ioError("EXDEV");
		if (from.includes(".pi-file-tools-move-")) throw ioError("EIO");
		return originalRename(from, to);
	});
	await assert.rejects(f.move(), { code: "EIO" });
	await assertOriginals(f);
});

test("failed publication and rollback retain the original destination backup", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	let publishing = false;
	patch("rename", async (from, to) => {
		if (from === f.source) throw ioError("EXDEV");
		if (from.includes(".pi-file-tools-move-")) {
			publishing = true;
			throw ioError("EIO");
		}
		if (publishing && to === f.destination) throw ioError("EACCES");
		return originalRename(from, to);
	});
	await assert.rejects(
		f.move(),
		/rollback failed.*original destination is preserved at/,
	);
	assert.equal(await fs.readFile(f.source, "utf8"), "new");
	const entries = await fs.readdir(f.root);
	const backup = entries.find((entry) =>
		entry.startsWith(".pi-file-tools-rename-"),
	);
	assert.ok(backup);
	assert.equal(
		await fs.readFile(join(f.root, backup, "destination"), "utf8"),
		"old",
	);
	assert.equal(
		entries.some((entry) => entry.startsWith(".pi-file-tools-move-")),
		false,
	);
});

test("backup cleanup failure after publication keeps the source intact", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	let published = false;
	patch("rename", async (from, to) => {
		if (from === f.source) throw ioError("EXDEV");
		await originalRename(from, to);
		if (from.includes(".pi-file-tools-move-")) published = true;
	});
	patch("rm", async (path, options) => {
		if (published && basename(path).startsWith(".pi-file-tools-rename-")) {
			throw ioError("EACCES");
		}
		return originalRm(path, options);
	});
	await assert.rejects(
		f.move(),
		/complete destination was kept.*source.*was left intact.*backup at.*EACCES/,
	);
	assert.equal(await fs.readFile(f.source, "utf8"), "new");
	assert.equal(await fs.readFile(f.destination, "utf8"), "new");
	const entries = await fs.readdir(f.root);
	const backup = entries.find((entry) =>
		entry.startsWith(".pi-file-tools-rename-"),
	);
	assert.ok(backup);
	assert.equal(
		await fs.readFile(join(f.root, backup, "destination"), "utf8"),
		"old",
	);
	assert.equal(
		entries.some((entry) => entry.startsWith(".pi-file-tools-move-")),
		false,
	);
});

test("partial source removal never rolls back the complete destination", async () => {
	const f = await fixture();
	await fs.mkdir(f.source);
	await fs.writeFile(join(f.source, "a"), "a");
	await fs.writeFile(join(f.source, "b"), "b");
	await fs.mkdir(f.destination);
	await fs.writeFile(join(f.destination, "old"), "old");
	patch("rm", async (path, options) => {
		if (path === f.source) {
			await originalRm(join(path, "a"));
			throw ioError("EACCES");
		}
		return originalRm(path, options);
	});
	await assert.rejects(
		f.move(),
		/complete destination was kept.*partially or entirely.*EACCES/,
	);
	assert.equal(await fs.readFile(join(f.destination, "a"), "utf8"), "a");
	assert.equal(await fs.readFile(join(f.destination, "b"), "utf8"), "b");
	assert.equal(await fs.readFile(join(f.source, "b"), "utf8"), "b");
	await assert.rejects(fs.lstat(join(f.source, "a")), { code: "ENOENT" });
	assert.deepEqual((await fs.readdir(f.root)).sort(), [
		"destination",
		"source",
	]);
});

test("abort after publication retains both copies and reports the incomplete move", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	patch("rename", async (from, to) => {
		if (from === f.source) throw ioError("EXDEV");
		await originalRename(from, to);
		if (from.includes(".pi-file-tools-move-")) f.controller.abort();
	});
	await assert.rejects(
		f.move(),
		/complete destination was kept.*Operation aborted/,
	);
	assert.equal(await fs.readFile(f.source, "utf8"), "new");
	assert.equal(await fs.readFile(f.destination, "utf8"), "new");
	assert.deepEqual((await fs.readdir(f.root)).sort(), [
		"destination",
		"source",
	]);
});

test("staging cleanup failures report the retained path after a completed move", async () => {
	const f = await fixture(false);
	await fs.writeFile(f.source, "new");
	patch("rm", async (path, options) => {
		if (basename(path).startsWith(".pi-file-tools-move-"))
			throw ioError("EACCES");
		return originalRm(path, options);
	});
	await assert.rejects(
		f.move(),
		/move completed; unable to clean up staging directory at.*EACCES/,
	);
	assert.equal(await fs.readFile(f.destination, "utf8"), "new");
	await assert.rejects(fs.lstat(f.source), { code: "ENOENT" });
});

test("special entries fail staging without removing the source or old destination", async () => {
	const f = await fixture();
	await fs.mkdir(f.source);
	await fs.mkdir(f.destination);
	await fs.writeFile(join(f.source, "file"), "new");
	await fs.writeFile(join(f.destination, "file"), "old");
	const socketPath = join(f.source, "socket");
	const server = createServer();
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		await assert.rejects(f.move(), /Cannot copy special filesystem entry/);
		assert.equal(await fs.readFile(join(f.source, "file"), "utf8"), "new");
		assert.equal(await fs.readFile(join(f.destination, "file"), "utf8"), "old");
		assert.equal((await fs.lstat(socketPath)).isSocket(), true);
		assert.deepEqual((await fs.readdir(f.root)).sort(), [
			"destination",
			"source",
		]);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("non-EXDEV rename errors do not attempt copying", async () => {
	const f = await fixture();
	await fs.writeFile(f.source, "new");
	await fs.writeFile(f.destination, "old");
	patch("rename", async (from, to) => {
		if (from === f.source) throw ioError("EACCES");
		return originalRename(from, to);
	});
	const copy = mock.fn(originalCopyFile);
	patch("copyFile", copy);
	await assert.rejects(f.move(), { code: "EACCES" });
	assert.equal(copy.mock.callCount(), 0);
	await assertOriginals(f);
});
