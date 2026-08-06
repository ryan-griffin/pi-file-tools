import {
	chmod,
	copyFile,
	mkdir as fsMkdir,
	rename as fsRename,
	lstat,
	mkdtemp,
	readdir,
	readlink,
	rm,
	symlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	assertPathUnchanged,
	canonicalPath,
	entryKind,
	isDirectoryPathInside,
	isPathAncestor,
	mutation,
	pathExists,
	protectedDeleteReason,
	resolveToolCwd,
	resolveToolPath,
	sameRealPath,
	throwIfAborted,
} from "../paths.js";

const parameters = Type.Object(
	{
		source: Type.String({
			description:
				"Path to the file, symlink, or directory to copy (relative or absolute)",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		destination: Type.String({
			description:
				"Destination path for the copy (relative or absolute). Parent directories are not created.",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		recursive: Type.Optional(
			Type.Boolean({
				description:
					"Copy directories recursively. Required for directory sources. Defaults to false.",
			}),
		),
		overwrite: Type.Optional(
			Type.Boolean({
				description: "Replace an existing destination. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof parameters>;

async function copyEntry(
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

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function combinedFailure(operation: unknown, cleanup: unknown): Error {
	return new Error(
		`${messageFor(operation)}; unable to clean up temporary copy: ${messageFor(cleanup)}.`,
		{ cause: operation },
	);
}

async function cleanupTemporary(path: string): Promise<unknown> {
	try {
		await rm(path, { recursive: true, force: false });
		return undefined;
	} catch (error) {
		return error;
	}
}

export function registerCopy(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "copy",
		label: "copy",
		description:
			"Copy a file, symlink, or directory. Parent directories are not created; directory copies require recursive: true and existing destinations require overwrite: true.",
		promptSnippet:
			"Copy a file or directory; recursive: true for directories, overwrite: true to replace a destination",
		parameters,
		async execute(_callId, params: Params, signal, _onUpdate, ctx) {
			const cwd = resolveToolCwd(ctx);
			const source = resolveToolPath(params.source, cwd, "source");
			const destination = resolveToolPath(
				params.destination,
				cwd,
				"destination",
			);
			throwIfAborted(signal);
			if (source === destination)
				throw new Error("Source and destination must differ.");
			const expectedSource = await canonicalPath(source);
			const expectedDestination = await canonicalPath(destination);
			return mutation([source, destination], cwd, async () => {
				throwIfAborted(signal);
				await assertPathUnchanged(source, expectedSource, "source");
				await assertPathUnchanged(
					destination,
					expectedDestination,
					"destination",
				);
				const sourceStat = await lstat(source);
				if (await sameRealPath(source, destination))
					throw new Error("Source and destination must differ.");
				if (await isDirectoryPathInside(source, destination)) {
					throw new Error("Cannot copy a directory into its own descendant.");
				}
				if (sourceStat.isDirectory() && !params.recursive) {
					throw new Error("Copying a directory requires recursive: true.");
				}
				const destinationExists = await pathExists(destination);
				if (destinationExists && params.overwrite) {
					const protection = await protectedDeleteReason(destination, cwd);
					if (protection)
						throw new Error(
							`Refusing to overwrite ${protection}: ${destination}.`,
						);
					if (await isPathAncestor(destination, source)) {
						throw new Error("Cannot overwrite an ancestor of the source.");
					}
					const destinationStat = await lstat(destination);
					if (destinationStat.isDirectory() !== sourceStat.isDirectory()) {
						// Same as mv -T / cp -T: replacing a directory with a file or
						// symlink (or vice versa) would silently discard the old
						// directory tree via backup cleanup. Refuse instead.
						throw new Error(
							`Refusing to overwrite a ${entryKind(destinationStat)} with a ${entryKind(sourceStat)}: ${destination}; delete or move the destination first.`,
						);
					}
				}
				if (destinationExists && !params.overwrite) {
					throw new Error(
						"Destination already exists; set overwrite: true to replace it.",
					);
				}

				let temporaryDirectory: string | undefined;
				let backupDirectory: string | undefined;
				try {
					throwIfAborted(signal);
					temporaryDirectory = await mkdtemp(
						join(dirname(destination), ".pi-file-tools-copy-"),
					);
					throwIfAborted(signal);
					const staged = join(temporaryDirectory, basename(destination));
					await copyEntry(source, staged, !!params.recursive, signal);
					throwIfAborted(signal);

					if (destinationExists) {
						throwIfAborted(signal);
						backupDirectory = await mkdtemp(
							join(dirname(destination), ".pi-file-tools-backup-"),
						);
						throwIfAborted(signal);
						const backup = join(backupDirectory, basename(destination));
						await fsRename(destination, backup);
						try {
							throwIfAborted(signal);
							await fsRename(staged, destination);
						} catch (swapError) {
							try {
								await fsRename(backup, destination);
							} catch (rollbackError) {
								// Keep the backup in place when rollback itself fails: the old
								// destination remains recoverable instead of being discarded.
								backupDirectory = undefined;
								throw new Error(
									`${messageFor(swapError)}; rollback failed and the original destination is preserved at ${backup}: ${messageFor(rollbackError)}.`,
									{ cause: swapError },
								);
							}
							throw swapError;
						}
					} else {
						throwIfAborted(signal);
						await fsRename(staged, destination);
					}
				} catch (error) {
					const failedCleanupErrors = (
						await Promise.all(
							[temporaryDirectory, backupDirectory]
								.filter((path): path is string => path !== undefined)
								.map(cleanupTemporary),
						)
					).filter(
						(cleanupError): cleanupError is unknown =>
							cleanupError !== undefined,
					);
					if (failedCleanupErrors.length > 0)
						throw combinedFailure(error, failedCleanupErrors[0]);
					throw error;
				}
				const cleanupErrors = (
					await Promise.all(
						[temporaryDirectory, backupDirectory]
							.filter((path): path is string => path !== undefined)
							.map(cleanupTemporary),
					)
				).filter(
					(cleanupError): cleanupError is unknown => cleanupError !== undefined,
				);
				if (cleanupErrors.length > 0) {
					throw new Error(
						`Copy completed but the temporary copy could not be cleaned up: ${messageFor(cleanupErrors[0])}.`,
						{ cause: cleanupErrors[0] },
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `Copied ${source} to ${destination}${params.overwrite ? " (overwriting destination)" : ""}.`,
						},
					],
					details: {
						source,
						destination,
						recursive: params.recursive ?? false,
						overwrite: params.overwrite ?? false,
						kind: entryKind(sourceStat),
					},
				};
			});
		},
	});
}
