import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type PathContext = { cwd?: string };

function isNodeError(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

/** Classify an lstat result for the details.kind field. */
export function entryKind(stat: Stats): "file" | "directory" | "symlink" {
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symlink";
	return "file";
}

/** Normalize pi's optional @ path marker and resolve against the tool cwd. */
export function resolveToolPath(
	value: unknown,
	cwd: string | undefined,
	name: string,
): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} must be a non-empty path.`);
	}
	const normalized = value.startsWith("@") ? value.slice(1) : value;
	if (
		normalized.length === 0 ||
		[...normalized].some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || (code >= 127 && code <= 159);
		})
	) {
		throw new Error(`${name} must not be empty or contain control characters.`);
	}
	const base = cwd && cwd.length > 0 ? cwd : process.cwd();
	return resolve(base, normalized);
}

export function resolveToolCwd(ctx: PathContext): string {
	return resolve(ctx.cwd && ctx.cwd.length > 0 ? ctx.cwd : process.cwd());
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"))
			return false;
		throw error;
	}
}

/** Resolve a path through all existing symlinked parents, including the path itself. */
export async function canonicalPath(path: string): Promise<string> {
	let current = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try {
			const resolved = await realpath(current);
			return resolve(resolved, ...suffix.toReversed());
		} catch (error) {
			if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTDIR"))
				throw error;
			const parent = dirname(current);
			if (parent === current) return resolve(current, ...suffix.toReversed());
			suffix.push(basename(current));
			current = parent;
		}
	}
}

/** Refuse to operate if a path was redirected while waiting for mutation locks. */
export async function assertPathUnchanged(
	path: string,
	expectedCanonical: string,
	label: string,
): Promise<void> {
	const actualCanonical = await canonicalPath(path);
	if (
		normalizeMutationKey(actualCanonical) !==
		normalizeMutationKey(expectedCanonical)
	) {
		throw new Error(
			`${label.charAt(0).toUpperCase() + label.slice(1)} changed while waiting for mutation locks; refusing to follow redirected path: ${path}.`,
		);
	}
}

function normalizeMutationKey(path: string): string {
	return path;
}

function isPathWithinOrEqual(parent: string, child: string): boolean {
	const normalizedParent = normalizeMutationKey(resolve(parent));
	const normalizedChild = normalizeMutationKey(resolve(child));
	const childRelative = relative(normalizedParent, normalizedChild);
	return (
		childRelative.length === 0 ||
		(!childRelative.startsWith(`..${sep}`) &&
			childRelative !== ".." &&
			!isAbsolute(childRelative))
	);
}

/** Return a lexical or canonical ancestor chain, stopping at the boundary. */
function ancestorChain(path: string, boundary: string): string[] {
	const resolvedPath = resolve(path);
	const resolvedBoundary = resolve(boundary);
	const stopAtBoundary = isPathWithinOrEqual(resolvedBoundary, resolvedPath);
	const chain: string[] = [];
	let current = resolvedPath;
	for (;;) {
		chain.push(current);
		if (
			(stopAtBoundary &&
				normalizeMutationKey(current) ===
					normalizeMutationKey(resolvedBoundary)) ||
			(!stopAtBoundary && current === parse(current).root)
		)
			return chain;

		const parent = dirname(current);
		if (parent === current) return chain;
		if (
			stopAtBoundary &&
			normalizeMutationKey(parent) === normalizeMutationKey(resolvedBoundary)
		) {
			chain.push(resolvedBoundary);
			return chain;
		}
		current = parent;
	}
}

/** Resolve a path exactly as withFileMutationQueue keys its queue. */
async function mutationQueueKey(path: string): Promise<string> {
	try {
		return await realpath(resolve(path));
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"))
			return resolve(path);
		throw error;
	}
}

/** Code-point total order for mutation-lock keys: locale-independent. */
function compareLockKeys(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export async function mutation<T>(
	paths: string[],
	activeCwd: string,
	fn: () => Promise<T>,
): Promise<T> {
	const resolvedBoundary = resolve(activeCwd);
	const canonicalBoundary = await canonicalPath(resolvedBoundary);
	const operationPaths = await Promise.all(
		paths.map(async (path) => ({
			raw: ancestorChain(path, resolvedBoundary),
			canonical: ancestorChain(await canonicalPath(path), canonicalBoundary),
		})),
	);
	const lockKeys = await Promise.all(
		operationPaths
			.flatMap(({ raw, canonical }) => [...raw, ...canonical])
			.map((path) => canonicalPath(path)),
	);
	const ordered = [...new Set(lockKeys.map(normalizeMutationKey))].sort(
		compareLockKeys,
	);
	const acquire = async (
		index: number,
		acquired: ReadonlyMap<string, string>,
	): Promise<T> => {
		if (index === ordered.length) return fn();
		const key = ordered[index] as string;
		// withFileMutationQueue re-resolves each key with its own realpath
		// (lexical fallback for missing paths). If a concurrent mutation
		// redirected a parent after the keys were computed, two distinct keys
		// can converge on one queue slot; acquiring them nested would then
		// wait on our own slot for the shared path and hang forever. Detect
		// the convergence immediately before acquiring and fail explicitly.
		const effective = await mutationQueueKey(key);
		const previous = acquired.get(effective);
		if (previous !== undefined) {
			throw new Error(
				`Mutation lock paths ${previous} and ${key} converged while waiting for mutation locks; refusing to deadlock: ${effective}.`,
			);
		}
		const nextAcquired = new Map(acquired);
		nextAcquired.set(effective, key);
		return withFileMutationQueue(key, () => acquire(index + 1, nextAcquired));
	};
	return acquire(0, new Map());
}

function isPathInside(source: string, destination: string): boolean {
	const child = relative(source, destination);
	return (
		child.length > 0 &&
		!child.startsWith(`..${sep}`) &&
		child !== ".." &&
		!isAbsolute(child)
	);
}

export async function isDirectoryPathInside(
	source: string,
	destination: string,
): Promise<boolean> {
	const sourceTarget = await canonicalPath(source);
	try {
		const sourceStat = await lstat(sourceTarget);
		if (!sourceStat.isDirectory()) return false;
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"))
			return false;
		throw error;
	}
	return isPathInside(sourceTarget, await canonicalPath(destination));
}

/** Whether destination is a strict ancestor of source after symlink resolution. */
export async function isPathAncestor(
	destination: string,
	source: string,
): Promise<boolean> {
	return isPathInside(
		await canonicalPath(destination),
		await canonicalPath(source),
	);
}

/** Resolve to a real path, treating a missing path as undefined. */
async function realpathOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"))
			return undefined;
		throw error;
	}
}

/**
 * Protection label when the target's real path is a boundary's real path
 * itself, or lies inside it (making the target an ancestor of the boundary).
 */
function realBoundaryProtection(
	targetReal: string,
	boundaryReal: string | undefined,
	boundaryLabel: string,
): string | undefined {
	if (boundaryReal === undefined) return undefined;
	if (targetReal === boundaryReal) return boundaryLabel;
	if (isPathInside(targetReal, boundaryReal)) {
		return `an ancestor of ${boundaryLabel}`;
	}
	return undefined;
}

export async function protectedDeleteReason(
	path: string,
	activeCwd: string,
): Promise<string | undefined> {
	const target = resolve(path);
	const root = parse(target).root;
	const home = resolve(homedir());
	const cwd = resolve(activeCwd);
	if (target === root) return "the filesystem root";

	// lstat is intentional: unlinking a symlink must not be treated as deleting
	// the directory it points to (including when that directory is cwd or home).
	let targetIsLink = false;
	try {
		const targetStat = await lstat(target);
		targetIsLink = targetStat.isSymbolicLink();
	} catch (error) {
		if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTDIR"))
			throw error;
		if (target === home) return "the home directory";
		if (target === cwd) return "the active working directory";
		return undefined;
	}
	if (targetIsLink) return undefined;
	if (target === home) return "the home directory";
	if (target === cwd) return "the active working directory";

	try {
		const targetReal = await realpath(target);
		return (
			realBoundaryProtection(
				targetReal,
				await realpathOrUndefined(cwd),
				"the active working directory",
			) ??
			realBoundaryProtection(
				targetReal,
				await realpathOrUndefined(home),
				"the home directory",
			)
		);
	} catch (error) {
		if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTDIR"))
			throw error;
	}
	return undefined;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export async function sameRealPath(
	left: string,
	right: string,
): Promise<boolean> {
	try {
		return (await realpath(left)) === (await realpath(right));
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR"))
			return false;
		throw error;
	}
}

export { isNodeError };
