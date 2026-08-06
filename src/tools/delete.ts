import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	assertPathUnchanged,
	canonicalPath,
	entryKind,
	mutation,
	protectedDeleteReason,
	resolveToolCwd,
	resolveToolPath,
	throwIfAborted,
} from "../paths.js";

const parameters = Type.Object(
	{
		path: Type.String({
			description:
				"Path to the file, symlink, or directory to delete (relative or absolute)",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		recursive: Type.Optional(
			Type.Boolean({
				description:
					"Delete a non-empty directory recursively. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof parameters>;

export function registerDelete(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delete",
		label: "delete",
		description:
			"Delete a file, symlink, or directory. Non-empty directories require recursive: true. Deletion is permanent; the filesystem root, home directory, and active working directory are protected.",
		promptSnippet:
			"Delete a path; recursive: true is required for non-empty directories",
		parameters,
		async execute(_callId, params: Params, signal, _onUpdate, ctx) {
			const cwd = resolveToolCwd(ctx);
			const target = resolveToolPath(params.path, cwd, "path");
			throwIfAborted(signal);
			const expectedTarget = await canonicalPath(target);
			return mutation([target], cwd, async () => {
				throwIfAborted(signal);
				await assertPathUnchanged(target, expectedTarget, "path");
				const protection = await protectedDeleteReason(target, cwd);
				if (protection)
					throw new Error(`Refusing to delete ${protection}: ${target}.`);
				const stat = await lstat(target);
				const isDirectory = stat.isDirectory();
				if (isDirectory && !params.recursive) {
					const entries = await readdir(target);
					if (entries.length > 0)
						throw new Error(
							"Directory is not empty; set recursive: true to delete it.",
						);
				}
				throwIfAborted(signal);
				if (isDirectory && !params.recursive) {
					await rmdir(target);
				} else {
					// fs.rm does not currently accept an AbortSignal. Check before the
					// irreversible operation rather than attempting unsafe partial deletion.
					await rm(target, { recursive: true, force: false });
				}
				return {
					content: [
						{
							type: "text",
							text: `Deleted ${target}${isDirectory ? " (directory)" : ""}.`,
						},
					],
					details: {
						path: target,
						recursive: params.recursive ?? false,
						kind: entryKind(stat),
					},
				};
			});
		},
	});
}
