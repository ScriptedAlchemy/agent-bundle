import { readFile } from "node:fs/promises";




const healthyCompilerStatus = Object.freeze({
    checks: Object.freeze([
        Object.freeze({
            label: 'Availability',
            status: 'passing'
        }),
        Object.freeze({
            label: 'Build queue',
            status: 'passing'
        })
    ]),
    service: 'compiler',
    status: 'healthy',
    summary: 'Compiler service is ready for release.'
});
const isRecord = (value)=>value !== null && typeof value === 'object' && !Array.isArray(value);
const isHealthyCompilerFixture = (value)=>{
    if (!isRecord(value) || value.service !== healthyCompilerStatus.service || value.status !== healthyCompilerStatus.status || value.summary !== healthyCompilerStatus.summary || !Array.isArray(value.checks) || value.checks.length !== healthyCompilerStatus.checks.length) {
        return false;
    }
    return healthyCompilerStatus.checks.every((expected, index)=>{
        const received = value.checks[index];
        return isRecord(received) && received.label === expected.label && received.status === expected.status;
    });
};



const fixturePath = new URL('../assets/evals/fixtures/status/result.json', import.meta.url);
/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope (argv, awaiting, numeric-return exit-code adoption) around it.
 */ const main = async ()=>{
    try {
        const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
        if (!isHealthyCompilerFixture(fixture)) {
            throw new Error('compiler fixture must contain the exact healthy compiler status');
        }
        process.stdout.write('Compiler fixture is healthy.\n');
        return 0;
    } catch (error) {
        process.stderr.write(`Unable to verify service fixture: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
};


const check_service_fixture_entry_main = main;
if (typeof check_service_fixture_entry_main !== 'function') {
    throw new TypeError('Executable entry must export a main function: ' + "/fast/projects/agent-bundle-worktrees/host-test/examples/mcp-app/src/scripts/check-service-fixture.ts");
}
const code = await check_service_fixture_entry_main(process.argv.slice(2));
if (typeof code === 'number') process.exitCode = code;

export {};
