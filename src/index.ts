/**
 * pi-file-tools — safe filesystem mutation tools for the pi coding agent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCopy } from "./tools/copy.js";
import { registerDelete } from "./tools/delete.js";
import { registerMkdir } from "./tools/mkdir.js";
import { registerRename } from "./tools/rename.js";

/**
 * Best-effort integration with the `@gotgenes/pi-permission-system` extension.
 *
 * That extension gates tool calls on the paths they access (cross-cutting
 * `path` rules and the `external_directory` outside-CWD boundary). `delete`
 * and `mkdir` carry `input.path`, so they are covered by convention. `rename`
 * and `copy` carry `source`/`destination` instead, so we declare the path they
 * touch: the destination is the path whose write crosses the boundary.
 *
 * Everything here is optional — if the permission system is not installed
 * (or already owns an extractor for a tool name), the registration is skipped
 * and pi-file-tools works standalone.
 */
function registerPermissionExtractors(pi: ExtensionAPI): void {
	// The permission system publishes its service on `globalThis` at
	// `session_start` and re-publishes on extension reload; registering from
	// the readiness broadcast makes this robust to load order and `/reload`.
	const disposers: Array<() => void> = [];
	let warnedAboutUnresolvable = false;
	const registerWithPermissionSystem = (via: "startup" | "ready"): void => {
		void import("@gotgenes/pi-permission-system")
			.then(({ getPermissionsService }) => {
				const permissions = getPermissionsService();
				if (permissions === undefined) {
					return;
				}
				// Idempotent across repeated readiness broadcasts: evict our
				// previous registrations first (the disposal is identity-guarded,
				// so a stale disposer against a reloaded registry is a no-op).
				for (const dispose of disposers.splice(0)) {
					dispose();
				}
				const register = (toolName: string): void => {
					try {
						disposers.push(
							permissions.registerToolAccessExtractor(toolName, (input) =>
								typeof input.destination === "string"
									? input.destination
									: undefined,
							),
						);
					} catch {
						// Another extension already owns this tool name — theirs wins.
					}
				};
				register("rename");
				register("copy");
			})
			.catch(() => {
				// The permission system announced itself on `permissions:ready` but
				// the package is not resolvable from this extension — a silent
				// integration failure that leaves rename/copy ungated. Only the
				// readiness path can distinguish this from "not installed at all".
				if (via === "ready" && !warnedAboutUnresolvable) {
					warnedAboutUnresolvable = true;
					console.error(
						"[pi-file-tools] the permission system broadcast `permissions:ready` but `@gotgenes/pi-permission-system` is not resolvable from this extension; rename/copy destination paths are NOT gated by permission policy",
					);
				}
			});
	};
	pi.events?.on("permissions:ready", () =>
		registerWithPermissionSystem("ready"),
	);
	registerWithPermissionSystem("startup");
}

export default function piFileToolsExtension(pi: ExtensionAPI): void {
	registerRename(pi);
	registerDelete(pi);
	registerCopy(pi);
	registerMkdir(pi);
	registerPermissionExtractors(pi);
}
