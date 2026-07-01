/**
 * Run the one-time heal. `markerPath` is a file under the Spellguard config dir;
 * once it exists the function short-circuits without probing git.
 */
export declare function healLeakedGlobalGitConfig(markerPath: string): void;
