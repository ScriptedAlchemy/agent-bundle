// The require scope
var __webpack_require__ = {};

// webpack/runtime/define_property_getters
(() => {
__webpack_require__.d = (exports, getters, values) => {
	var define = (defs, kind) => {
		for(var key in defs) {
			if(__webpack_require__.o(defs, key) && !__webpack_require__.o(exports, key)) {
				Object.defineProperty(exports, key, { enumerable: true, [kind]: defs[key] });
			}
		}
	};
	define(getters, "get");
	define(values, "value");
};
})();
// webpack/runtime/has_own_property
(() => {
__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
})();
// webpack/runtime/make_namespace_object
(() => {
// define __esModule on exports
__webpack_require__.r = (exports) => {
	if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
	}
	Object.defineProperty(exports, '__esModule', { value: true });
};
})();

// NAMESPACE OBJECT: ./src/hooks/session-start.ts
var session_start_namespaceObject = {};
__webpack_require__.r(session_start_namespaceObject);
__webpack_require__.d(session_start_namespaceObject, { 
  "default": () => (session_start) });


/* export default */ const session_start = ((event)=>({
        additionalContext: [
            `Service readiness session ${event.sessionId ?? 'is active'} from ${event.source ?? 'an unknown source'}.`,
            `Use the service-readiness Skill, then run check-service-fixture from ${event.cwd ?? process.cwd()} before release review.`,
            'Use show-status for compiler or payments-api when live service evidence is needed.'
        ].join(' '),
        outcome: 'continue'
    }));


const target = "claude";
const canonicalEvent = "sessionStart";
const nativeEvent = "SessionStart";
const isRecord = (value)=>typeof value === "object" && value !== null && !Array.isArray(value);
const defined = (value)=>Object.fromEntries(Object.entries(value).filter(([, item])=>item !== undefined));
const decodeClaudeNative = (nativeInput)=>({
        agentId: nativeInput.agent_id,
        agentTranscriptPath: nativeInput.agent_transcript_path,
        agentType: nativeInput.agent_type,
        cwd: nativeInput.cwd,
        effort: nativeInput.effort,
        hookEventName: nativeInput.hook_event_name,
        lastAssistantMessage: nativeInput.last_assistant_message,
        model: nativeInput.model,
        permissionMode: nativeInput.permission_mode,
        promptId: nativeInput.prompt_id,
        sessionId: nativeInput.session_id,
        source: nativeInput.source,
        stopHookActive: nativeInput.stop_hook_active,
        toolInput: nativeInput.tool_input,
        toolName: nativeInput.tool_name,
        toolResponse: nativeInput.tool_response,
        toolUseId: nativeInput.tool_use_id,
        transcriptPath: nativeInput.transcript_path,
        turnId: nativeInput.turn_id
    });
const encodeClaudeNative = (canonicalInput)=>defined({
        hook_event_name: nativeEvent,
        agent_id: canonicalInput.agentId,
        agent_transcript_path: canonicalInput.agentTranscriptPath,
        agent_type: canonicalInput.agentType,
        cwd: canonicalInput.cwd,
        effort: canonicalInput.effort,
        last_assistant_message: canonicalInput.lastAssistantMessage,
        model: canonicalInput.model,
        permission_mode: canonicalInput.permissionMode,
        prompt_id: canonicalInput.promptId,
        session_id: canonicalInput.sessionId,
        source: canonicalInput.source,
        stop_hook_active: canonicalInput.stopHookActive,
        tool_input: canonicalInput.toolInput,
        tool_name: canonicalInput.toolName,
        tool_response: canonicalInput.toolResponse,
        tool_use_id: canonicalInput.toolUseId,
        transcript_path: canonicalInput.transcriptPath,
        turn_id: canonicalInput.turnId
    });
const decodeNative = decodeClaudeNative;
const encodeNative = encodeClaudeNative;
const fail = (message)=>{
    throw new Error(`Agent Bundle hook error: ${message}`);
};
const validateResult = (result)=>{
    if (result === undefined) return undefined;
    if (!isRecord(result)) fail("handler must return void or a result object");
    const allowed = new Set([
        "outcome",
        "reason",
        "updatedInput",
        "additionalContext"
    ]);
    for (const key of Object.keys(result))if (!allowed.has(key)) fail(`handler result has unsupported field ${key}`);
    if (result.outcome !== undefined && ![
        "continue",
        "deny",
        "stop"
    ].includes(result.outcome)) fail("handler result outcome is invalid");
    if (result.reason !== undefined && typeof result.reason !== "string") fail("handler result reason must be a string");
    if (result.additionalContext !== undefined && typeof result.additionalContext !== "string") fail("handler result additionalContext must be a string");
    if (result.updatedInput !== undefined && !isRecord(result.updatedInput)) fail("handler result updatedInput must be an object");
    const supportsDeniedReason = canonicalEvent === "beforeTool" || canonicalEvent === "stop" || canonicalEvent === "agentStop";
    if (result.reason !== undefined && !(result.outcome === "deny" && supportsDeniedReason)) fail("reason is only valid for a denied beforeTool, stop, or agentStop hook");
    if (result.outcome === "deny" && supportsDeniedReason && (typeof result.reason !== "string" || result.reason.trim().length === 0)) fail(`denied ${canonicalEvent} hook requires a nonempty reason`);
    if ((canonicalEvent === "sessionStart" || canonicalEvent === "afterTool" || canonicalEvent === "agentStart") && (result.outcome === "deny" || result.outcome === "stop" || result.updatedInput !== undefined)) fail(`${canonicalEvent} cannot deny, stop, or replace input`);
    if (canonicalEvent === "beforeTool" && (result.outcome === "stop" || result.outcome === "deny" && result.updatedInput !== undefined)) fail("beforeTool cannot stop or replace input while denying");
    if (canonicalEvent === "stop" && (result.outcome === "stop" || result.updatedInput !== undefined || result.additionalContext !== undefined)) fail("stop only accepts continue or deny with a reason");
    if (canonicalEvent === "agentStop" && (result.outcome === "stop" || result.updatedInput !== undefined)) fail("agentStop cannot stop the parent flow or replace input");
    if (canonicalEvent === "agentStop" && target === "codex" && 0) {}
    return result;
};
const encodeOutput = (result)=>{
    if (result === undefined) return undefined;
    if (canonicalEvent === "stop" || canonicalEvent === "agentStop") {
        if (result.outcome === "deny") return defined({
            decision: "block",
            reason: result.reason
        });
        if (canonicalEvent === "agentStop" && target === "claude" && result.additionalContext !== undefined) return {
            hookSpecificOutput: {
                additionalContext: result.additionalContext,
                hookEventName: nativeEvent
            }
        };
        return undefined;
    }
    const output = defined({
        additionalContext: result.additionalContext,
        hookEventName: nativeEvent,
        permissionDecision: canonicalEvent === "beforeTool" ? result.outcome === "deny" ? "deny" : "allow" : undefined,
        permissionDecisionReason: canonicalEvent === "beforeTool" && result.outcome === "deny" ? result.reason : undefined,
        updatedInput: canonicalEvent === "beforeTool" && result.outcome !== "deny" ? result.updatedInput : undefined
    });
    return Object.keys(output).length === 1 && output.hookEventName !== undefined ? undefined : {
        hookSpecificOutput: output
    };
};
const decodeOutput = (nativeOutput)=>{
    if (nativeOutput === undefined) return undefined;
    if (canonicalEvent === "stop" || canonicalEvent === "agentStop") {
        if (nativeOutput.decision === "block") return defined({
            outcome: "deny",
            reason: nativeOutput.reason
        });
        if (canonicalEvent === "agentStop" && target === "claude" && isRecord(nativeOutput.hookSpecificOutput)) return defined({
            additionalContext: nativeOutput.hookSpecificOutput.additionalContext,
            outcome: "continue"
        });
        return undefined;
    }
    const output = nativeOutput.hookSpecificOutput;
    if (!isRecord(output)) fail("native hook output is malformed");
    return defined({
        additionalContext: output.additionalContext,
        outcome: output.permissionDecision === "deny" ? "deny" : "continue",
        reason: output.permissionDecisionReason,
        updatedInput: output.updatedInput
    });
};
const requireString = (input, field)=>{
    if (typeof input[field] !== "string") fail(`native ${field} must be a string`);
};
const requireNullableString = (input, field)=>{
    if (input[field] !== null && typeof input[field] !== "string") fail(`native ${field} must be a string or null`);
};
const validateNativeInput = (input)=>{
    requireString(input, "session_id");
    if (false) {}
    else requireString(input, "transcript_path");
    requireString(input, "cwd");
    if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);
    if (input.prompt_id !== undefined) requireString(input, "prompt_id");
    if (input.permission_mode !== undefined) requireString(input, "permission_mode");
    if (input.model !== undefined) requireString(input, "model");
    if (canonicalEvent === "sessionStart") {
        requireString(input, "source");
        return;
    }
    if (canonicalEvent === "beforeTool" || canonicalEvent === "afterTool") {
        requireString(input, "tool_name");
        if (false) {} else if (!isRecord(input.tool_input)) fail(`native ${nativeEvent} tool_input must be an object`);
        requireString(input, "tool_use_id");
        if (canonicalEvent === "afterTool") {
            if (input.tool_response === undefined) fail("native PostToolUse tool_response is required");
        }
        return;
    }
    if (canonicalEvent === "agentStart" || canonicalEvent === "agentStop") {
        requireString(input, "agent_id");
        requireString(input, "agent_type");
        if (false) {}
        if (canonicalEvent === "agentStart") return;
        if (typeof input.stop_hook_active !== "boolean") fail("native SubagentStop stop_hook_active must be a boolean");
        requireNullableString(input, "agent_transcript_path");
        requireNullableString(input, "last_assistant_message");
        return;
    }
    if (typeof input.stop_hook_active !== "boolean") fail("native Stop stop_hook_active must be a boolean");
    if (false) {}
    else requireString(input, "last_assistant_message");
};
const run = async ()=>{
    const handler = Reflect.get(session_start_namespaceObject, "default");
    if (typeof handler !== "function") fail("default export must be a function");
    let raw = "";
    for await (const chunk of process.stdin)raw += chunk;
    if (raw.trim().length === 0) fail("stdin must contain exactly one JSON value");
    let input;
    try {
        input = JSON.parse(raw);
    } catch  {
        fail("stdin must contain exactly one JSON value");
    }
    if (!isRecord(input)) fail("stdin JSON value must be an object");
    const simulation = process.env.AGENT_BUNDLE_HOOK_SIMULATION === "1";
    const nativeInput = simulation ? encodeNative(input) : input;
    validateNativeInput(nativeInput);
    const event = decodeNative(nativeInput);
    const result = validateResult(await handler(event, {
        nativeEvent: nativeEvent,
        nativeInput,
        target: target
    }));
    const nativeOutput = encodeOutput(result);
    const output = simulation ? decodeOutput(nativeOutput) : nativeOutput;
    if (output !== undefined) process.stdout.write(JSON.stringify(output));
};
if (import.meta.main) {
    await run().catch((error)=>{
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}

export {};
