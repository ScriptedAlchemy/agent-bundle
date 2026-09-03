import { readFile } from "node:fs/promises";





const registerPath = new URL('../assets/release/risk-register.json', import.meta.url);
const main = async ()=>{
    try {
        const register = JSON.parse(await readFile(registerPath, 'utf8'));
        if (!Array.isArray(register.risks)) throw new Error('risk register must contain a risks array');
        const blockers = register.risks.filter((risk)=>risk.status === 'open' && risk.severity === 'high');
        if (blockers.length === 0) {
            process.stdout.write('No open high-severity release risks found.\n');
            return 0;
        }
        for (const risk of blockers){
            process.stderr.write(`${typeof risk.id === 'string' ? risk.id : 'UNIDENTIFIED'}: ${typeof risk.summary === 'string' ? risk.summary : 'Open high-severity release risk'}\n`);
        }
        return 2;
    } catch (error) {
        process.stderr.write(`Unable to detect release risks: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
};


const detect_risk_entry_main = main;
if (typeof detect_risk_entry_main !== 'function') {
    throw new TypeError('Executable entry must export a main function: ' + "/fast/projects/agent-bundle-worktrees/g1-followups/examples/hooks-and-scripts/src/scripts/detect-risk.ts");
}
const code = await detect_risk_entry_main(process.argv.slice(2));
if (typeof code === 'number') process.exitCode = code;

export {};
