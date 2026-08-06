import { rename as fsRename, lstat, mkdtemp, rm } from "node:fs/promises";
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
				"Path to the file, symlink, or directory to move (relative or absolute)",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		destination: Type.String({
			description:
				"Destination path for the move (relative or absolute). Parent directories are not created.",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		overwrite: Type.Optional(
			Type.Boolean({
				description: "Replace an existing destination. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof parameters>;

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Replace an existing destination without losing it if the move fails. */
async function renameWithOverwrite(
	source: string,
	destination: string,
	destinationExists: boolean,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfAborted(signal);
	if (!destinationExists) {
		await fsRename(source, destination);
		return;
	}

	const backupDirectory = await mkdtemp(
		join(dirname(destination), ".pi-file-tools-rename-"),
	);
	throwIfAborted(signal);
	const backup = join(backupDirectory, basename(destination));
	let failure: unknown;
	let keepBackup = false;

	try {
		throwIfAborted(signal);
		await fsRename(destination, backup);
		try {
			throwIfAborted(signal);
			await fsRename(source, destination);
		} catch (moveError) {
			try {
				await fsRename(backup, destination);
			} catch (rollbackError) {
				keepBackup = true;
				failure = new Error(
					`${messageFor(moveError)}; rollback failed and the original destination is preserved at ${backup}: ${messageFor(rollbackError)}.`,
					{ cause: moveError },
				);
			}
			if (!failure) failure = moveError;
		}
	} catch (error) {
		failure = error;
	}

	if (!keepBackup) {
		try {
			await rm(backupDirectory, { recursive: true, force: false });
		} catch (cleanupError) {
			failure = failure
				? new Error(
						`${messageFor(failure)}; unable to clean up rename backup: ${messageFor(cleanupError)}.`,
						{ cause: failure },
					)
				: new Error(
						`Rename completed but the temporary backup could not be cleaned up: ${messageFor(cleanupError)}.`,
						{ cause: cleanupError },
					);
		}
	}

	if (failure) throw failure;
}

export function registerRename(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "rename",
		label: "rename",
		description:
			"Rename or move a file, symlink, or directory. Parent directories are not created; existing destinations require overwrite: true.",
		promptSnippet:
			"Rename or move a file or directory; overwrite: true is required to replace a destination",
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
					throw new Error("Cannot move a directory into its own descendant.");
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
				throwIfAborted(signal);
				await renameWithOverwrite(
					source,
					destination,
					destinationExists,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: `Renamed ${source} to ${destination}${params.overwrite ? " (overwriting destination)" : ""}.`,
						},
					],
					details: {
						source,
						destination,
						overwrite: params.overwrite ?? false,
						kind: entryKind(sourceStat),
					},
				};
			});
		},
	});
}
