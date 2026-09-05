import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import {
	assertPathUnchanged,
	canonicalPath,
	entryKind,
	isDirectoryPathInside,
	isPathAncestor,
	mutation,
	type PathContext,
	pathExists,
	protectedDeleteReason,
	resolveToolCwd,
	resolveToolPath,
	sameRealPath,
	throwIfAborted,
} from "./paths.js";

/**
 * Shared single-path prologue for delete and mkdir: resolve the target
 * against the tool cwd, then acquire the mutation queue and re-verify that
 * the path was not redirected while waiting for the locks before running
 * the body.
 */
export async function withLockedTarget<T>(
	pathValue: string,
	ctx: PathContext,
	signal: AbortSignal | undefined,
	body: (target: string, cwd: string) => Promise<T>,
): Promise<T> {
	const cwd = resolveToolCwd(ctx);
	const target = resolveToolPath(pathValue, cwd, "path");
	throwIfAborted(signal);
	const expectedTarget = await canonicalPath(target);
	return mutation([target], cwd, async () => {
		throwIfAborted(signal);
		await assertPathUnchanged(target, expectedTarget, "path");
		return body(target, cwd);
	});
}

/**
 * Shared source→destination pipeline for rename and copy: resolve both paths
 * against the tool cwd, acquire the mutation queue for their lexical and
 * canonical ancestor chains, re-verify that neither path was redirected
 * while waiting for the locks, then run the guards every source→destination
 * mutation needs (move-source protection, same-real-path, descendant, and
 * the overwrite policy) before handing the validated context to the body.
 */
export async function withLockedSourceDestination<T>(
	{
		sourceValue,
		destinationValue,
		op,
		overwrite,
		ctx,
		signal,
	}: {
		sourceValue: string;
		destinationValue: string;
		op: "move" | "copy";
		overwrite: boolean;
		ctx: PathContext;
		signal: AbortSignal | undefined;
	},
	body: (guard: {
		source: string;
		destination: string;
		sourceStat: Stats;
		destinationExists: boolean;
	}) => Promise<T>,
): Promise<T> {
	const cwd = resolveToolCwd(ctx);
	const source = resolveToolPath(sourceValue, cwd, "source");
	const destination = resolveToolPath(destinationValue, cwd, "destination");
	throwIfAborted(signal);
	if (source === destination)
		throw new Error("Source and destination must differ.");
	const expectedSource = await canonicalPath(source);
	const expectedDestination = await canonicalPath(destination);
	return mutation([source, destination], cwd, async () => {
		throwIfAborted(signal);
		await assertPathUnchanged(source, expectedSource, "source");
		await assertPathUnchanged(destination, expectedDestination, "destination");
		if (op === "move") {
			// A move deletes the source: refuse to move the filesystem root,
			// the home directory, the active working directory, or any real
			// directory containing them — mirroring delete's protection.
			// Unlinking a symlink alias stays allowed (protectedDeleteReason
			// returns undefined for links), since only the link moves.
			const sourceProtection = await protectedDeleteReason(source, cwd);
			if (sourceProtection) {
				throw new Error(`Refusing to move ${sourceProtection}: ${source}.`);
			}
		}
		const sourceStat = await lstat(source);
		if (await sameRealPath(source, destination))
			throw new Error("Source and destination must differ.");
		if (await isDirectoryPathInside(source, destination)) {
			throw new Error(`Cannot ${op} a directory into its own descendant.`);
		}
		const destinationExists = await assertOverwritable({
			source,
			destination,
			sourceStat,
			overwrite,
			activeCwd: cwd,
		});
		return body({ source, destination, sourceStat, destinationExists });
	});
}

/**
 * Shared overwrite policy for rename and copy. Refuses to replace a
 * protected destination, an ancestor of the source, or a destination whose
 * entry kind differs from the source (replacing a directory with a file or
 * symlink — or vice versa — would silently discard the old tree via backup
 * cleanup; same as mv -T / cp -T). Returns whether the destination already
 * exists; callers use that for staging/rollback and result messages.
 */
async function assertOverwritable({
	source,
	destination,
	sourceStat,
	overwrite,
	activeCwd,
}: {
	source: string;
	destination: string;
	sourceStat: Stats;
	overwrite: boolean;
	activeCwd: string;
}): Promise<boolean> {
	const destinationExists = await pathExists(destination);
	if (!destinationExists) return false;
	if (!overwrite) {
		throw new Error(
			"Destination already exists; set overwrite: true to replace it.",
		);
	}
	const protection = await protectedDeleteReason(destination, activeCwd);
	if (protection) {
		throw new Error(`Refusing to overwrite ${protection}: ${destination}.`);
	}
	if (await isPathAncestor(destination, source)) {
		throw new Error("Cannot overwrite an ancestor of the source.");
	}
	const destinationStat = await lstat(destination);
	if (destinationStat.isDirectory() !== sourceStat.isDirectory()) {
		throw new Error(
			`Refusing to overwrite a ${entryKind(destinationStat)} with a ${entryKind(sourceStat)}: ${destination}; delete or move the destination first.`,
		);
	}
	return true;
}
