import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	assertPathUnchanged,
	canonicalPath,
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
				"File, symlink, or directory to delete; a leading @ is optional.",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		recursive: Type.Optional(
			Type.Boolean({
				description:
					"Required for non-empty directories. Defaults to false; deletion is permanent.",
			}),
		),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof parameters>;

export function registerDelete(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delete",
		label: "Delete",
		description:
			"Permanently delete a file, symlink, or directory. Non-empty directories require recursive=true; missing paths are errors. The filesystem root, home directory, and active cwd are protected.",
		promptSnippet:
			"Permanently delete a path; recursive is required for non-empty directories",
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
					throw new Error(`refusing to delete ${protection}: ${target}`);
				const stat = await lstat(target);
				const isDirectory = stat.isDirectory();
				if (isDirectory && !params.recursive) {
					const entries = await readdir(target);
					if (entries.length > 0)
						throw new Error(
							"directory is not empty; set recursive=true to delete it",
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
						kind: isDirectory ? "directory" : "file-or-link",
					},
				};
			});
		},
	});
}
