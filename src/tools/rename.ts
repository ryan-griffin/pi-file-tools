import { rename as fsRename, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { entryKind, throwIfAborted } from "../paths.js";
import { withLockedSourceDestination } from "../shared.js";

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
						`${messageFor(failure)}; unable to clean up rename backup at ${backupDirectory}: ${messageFor(cleanupError)}.`,
						{ cause: failure },
					)
				: new Error(
						`Rename completed but the temporary backup at ${backupDirectory} could not be cleaned up: ${messageFor(cleanupError)}.`,
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
		promptGuidelines: [
			"Existing destinations require overwrite: true; replacing a directory with a file or symlink (or vice versa) is refused.",
			"Parent directories are never created; use mkdir first when the destination parent is missing.",
		],
		parameters,
		async execute(_callId, params: Params, signal, _onUpdate, ctx) {
			return withLockedSourceDestination(
				{
					sourceValue: params.source,
					destinationValue: params.destination,
					op: "move",
					overwrite: params.overwrite ?? false,
					ctx,
					signal,
				},
				async ({ source, destination, sourceStat, destinationExists }) => {
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
								text: `Renamed ${source} to ${destination}${destinationExists ? " (overwriting destination)" : ""}.`,
							},
						],
						details: {
							source,
							destination,
							overwrite: params.overwrite ?? false,
							kind: entryKind(sourceStat),
						},
					};
				},
			);
		},
	});
}
