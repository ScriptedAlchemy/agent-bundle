import { readFile } from "node:fs/promises";





const requiredArtifacts = [
    'package',
    'checksums',
    'sbom'
];
const manifestPath = new URL('../assets/release/release-manifest.json', import.meta.url);
const readManifest = async ()=>JSON.parse(await readFile(manifestPath, 'utf8'));
const validationErrors = (manifest)=>{
    const errors = [];
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        errors.push('version must use major.minor.patch format');
    }
    if (typeof manifest.changelog !== 'string' || manifest.changelog.trim().length === 0) {
        errors.push('changelog must identify the release notes');
    }
    for (const name of requiredArtifacts){
        const artifact = manifest.artifacts?.find((candidate)=>candidate.name === name);
        if (artifact === undefined || typeof artifact.path !== 'string' || artifact.path.trim().length === 0 || artifact.status !== 'ready') {
            errors.push(`${name} artifact must have a ready path`);
        }
    }
    return errors;
};
const main = async ()=>{
    try {
        const manifest = await readManifest();
        const errors = validationErrors(manifest);
        if (errors.length > 0) {
            process.stderr.write(`Release manifest is incomplete:\n${errors.map((error)=>`- ${error}`).join('\n')}\n`);
            return 1;
        }
        process.stdout.write(`Release ${manifest.version} is ready for packaging.\n`);
        return 0;
    } catch (error) {
        process.stderr.write(`Unable to verify release manifest: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
};


const verify_release_entry_main = main;
if (typeof verify_release_entry_main !== 'function') {
    throw new TypeError('Executable entry must export a main function: ' + "/fast/projects/agent-bundle-worktrees/g1-followups/examples/hooks-and-scripts/src/scripts/verify-release.ts");
}
const code = await verify_release_entry_main(process.argv.slice(2));
if (typeof code === 'number') process.exitCode = code;

export {};
