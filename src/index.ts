/**
 * pi-file-tools — safe filesystem mutation tools for the pi coding agent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCopy } from "./tools/copy.js";
import { registerDelete } from "./tools/delete.js";
import { registerMkdir } from "./tools/mkdir.js";
import { registerRename } from "./tools/rename.js";

export default function piFileToolsExtension(pi: ExtensionAPI): void {
	registerRename(pi);
	registerDelete(pi);
	registerCopy(pi);
	registerMkdir(pi);
}
