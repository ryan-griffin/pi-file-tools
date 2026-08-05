import { rename as fsRename, lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	assertPathUnchanged,
	canonicalPath,
	isDirectoryPathInside,
	isPathAncestor,
	mutation,
	pathExists,
	resolveToolCwd,
	resolveToolPath,
	sameRealPath,
	throwIfAborted,
} from "../paths.js";

const parameters = Type.Object(
	{
		source: Type.String({
			description:
				"Existing file or directory to move; a leading @ is optional.",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		destination: Type.String({
			description: "Exact new path. Parent directories are not created.",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		overwrite: Type.Optional(
			Type.Boolean({
				description:
					"Replace an existing destination. Defaults to false; this is destructive.",
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
					`${messageFor(moveError)}; rollback failed and the original destination is preserved at ${backup}: ${messageFor(rollbackError)}`,
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
						`${messageFor(failure)}; unable to clean up rename backup: ${messageFor(cleanupError)}`,
						{ cause: failure },
					)
				: new Error(
						`rename completed but unable to clean up rename backup: ${messageFor(cleanupError)}`,
						{ cause: cleanupError },
					);
		}
	}

	if (failure) throw failure;
}

export function registerRename(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "rename",
		label: "Rename",
		description:
			"Move a file or directory to an exact destination path. Parents are not created; existing destinations require overwrite=true. Refuses moving a directory into itself.",
		promptSnippet:
			"Move or rename a file or directory; overwrite is required to replace a destination",
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
				throw new Error("source and destination must differ");
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
					throw new Error("source and destination must differ");
				if (await isDirectoryPathInside(source, destination)) {
					throw new Error("cannot move a directory into its own descendant");
				}
				const destinationExists = await pathExists(destination);
				if (
					destinationExists &&
					params.overwrite &&
					(await isPathAncestor(destination, source))
				) {
					throw new Error("cannot overwrite an ancestor of the source");
				}
				if (destinationExists && !params.overwrite) {
					throw new Error(
						"destination already exists; set overwrite=true to replace it",
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
						kind: sourceStat.isDirectory() ? "directory" : "file-or-link",
					},
				};
			});
		},
	});
}
