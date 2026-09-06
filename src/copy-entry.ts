import {
	chmod,
	copyFile,
	mkdir as fsMkdir,
	lstat,
	readdir,
	readlink,
	symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { throwIfAborted } from "./paths.js";

/** Copy files, directories, and links without following symlinks. */
export async function copyEntry(
	source: string,
	destination: string,
	recursive: boolean,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfAborted(signal);
	const sourceStat = await lstat(source);
	if (sourceStat.isSymbolicLink()) {
		const target = await readlink(source);
		throwIfAborted(signal);
		await symlink(target, destination);
		return;
	}
	if (sourceStat.isDirectory()) {
		if (!recursive)
			throw new Error("Copying a directory requires recursive: true.");
		throwIfAborted(signal);
		await fsMkdir(destination);
		for (const entry of await readdir(source)) {
			throwIfAborted(signal);
			await copyEntry(
				join(source, entry),
				join(destination, entry),
				recursive,
				signal,
			);
		}
		throwIfAborted(signal);
		await chmod(destination, sourceStat.mode & 0o7777);
		return;
	}
	if (!sourceStat.isFile()) {
		throw new Error(`Cannot copy special filesystem entry: ${source}.`);
	}
	throwIfAborted(signal);
	await copyFile(source, destination);
	throwIfAborted(signal);
	await chmod(destination, sourceStat.mode & 0o7777);
}
