/**
 * The setup script is plain JavaScript so `npm run setup` can run before the first build. This declaration is
 * what lets a unit test exercise its patch back-fill (the path that rewrites the profile's cordis.patch.yml,
 * which DSH rewrites as YAML after the first boot) without compiling the script itself.
 */

/** A row DSH's plugin manager wrote or kept in `cordis.patch.yml`: an inserted plugin row or an override row. */
export interface PatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  insert?: PatchRow[];
  config?: Record<string, unknown>;
}

/**
 * Keeps the workspace its own project root so the repository this checkout lives in is not loaded as
 * instructions into every channel session. See the comment in scripts/setup.mjs.
 */
export declare const instructionFence: {
  id: string;
  name: string;
  config: { maxBytes: number; projectRootMarkers: string[] };
};

/**
 * Add whatever an older profile's patch is missing, in place, and return it. Idempotent: a patch that is
 * already current is returned unchanged, so `setup` leaves the file alone.
 * @param patch - layers as parsed from `cordis.patch.yml` (JSON is valid YAML).
 * @param coderRoots - the development profile's project roots.
 */
export declare function backfillProfilePatch(patch: PatchRow[], coderRoots: string[]): PatchRow[];
