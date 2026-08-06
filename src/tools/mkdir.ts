import { mkdir as fsMkdir, lstat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { pathExists, throwIfAborted } from "../paths.js";
import { withLockedTarget } from "../shared.js";

const parameters = Type.Object(
	{
		path: Type.String({
			description: "Path to the directory to create (relative or absolute)",
			minLength: 1,
			pattern: "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]+$",
		}),
		recursive: Type.Optional(
			Type.Boolean({
				description: "Create missing parent directories. Defaults to true.",
			}),
		),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof parameters>;

export function registerMkdir(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "mkdir",
		label: "mkdir",
		description:
			"Create a directory, creating missing parent directories by default. Reports whether the directory already existed; an existing non-directory is an error.",
		promptSnippet: "Create a directory (recursive by default)",
		parameters,
		async execute(_callId, params: Params, signal, _onUpdate, ctx) {
			return withLockedTarget(params.path, ctx, signal, async (target) => {
				if (await pathExists(target)) {
					const stat = await lstat(target);
					if (!stat.isDirectory())
						throw new Error(`Path exists and is not a directory: ${target}.`);
					return {
						content: [
							{ type: "text", text: `Directory already exists: ${target}.` },
						],
						details: {
							path: target,
							recursive: params.recursive ?? true,
							created: false,
						},
					};
				}
				throwIfAborted(signal);
				await fsMkdir(target, { recursive: params.recursive ?? true });
				return {
					content: [{ type: "text", text: `Created directory: ${target}.` }],
					details: {
						path: target,
						recursive: params.recursive ?? true,
						created: true,
					},
				};
			});
		},
	});
}
