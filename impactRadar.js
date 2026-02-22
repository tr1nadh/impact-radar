#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import OpenAI from 'openai';
import { performance } from 'perf_hooks';
import path from 'path';
import fs from 'fs';
import open from 'open';
import { fileURLToPath } from 'url'; // New import
import { dirname } from 'path'; // New import for dirname
import { exec } from 'child_process';


import { parseToGraph } from './graphParser.js';
import { calculateBlastRadius } from './impactAnalysis.js';
import { scanCallerSafety } from './callerSafetyScanner.js';

// Initialize yargs for command-line arguments
const argv = yargs(hideBin(process.argv))
    .option('project', { type: 'string', demandOption: true, description: 'Path to the project directory to analyze.' })
    .option('target', { type: 'string', demandOption: true, description: 'The specific function or API endpoint that was changed (e.g., "getUserById").' })
    .option('change_type', {
        type: 'string',
        demandOption: true,
        description: 'Detailed semantic type of the change, including behavioral delta (e.g., "added_throw_statement::from:returns null,to:throws error").'
    })
    .option('criticality_flags', {
        type: 'string',
        default: '',
        description: 'Comma-separated flags describing the business criticality of the target (e.g., "public_endpoint,auth_related,payment_related").'
    })
    .option('include_caller_safety_scan', {
        type: 'boolean',
        default: true,
        description: 'Whether to perform a caller-side safety analysis for impacted functions.'
    })
    .option('visualize', {
        type: 'boolean',
        default: false,
        description: 'Generate and open an HTML visualization of the impact report.'
    })
    .argv;

// Define __filename and __dirname for ES Modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize OpenAI client only if key is present
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
}

// 🧠 Upgrade 1 — Behavioral Diff Engine (CRITICAL) - Simplified profiles, as the change_type string carries more weight
const SEMANTIC_CHANGE_PROFILES = {
    "added_throw_statement": { base: 8.5, impact_weight: 0.22, default_description: "A function that previously returned a value or undefined now throws an exception." },
    "removed_fallback_behavior": { base: 7.5, impact_weight: 0.18, default_description: "Removes logic that previously handled nulls, undefineds, or error states gracefully." },
    "stricter_input_constraint": { base: 6.0, impact_weight: 0.15, default_description: "Introduces new validation or makes existing input validation more restrictive." },
    "changed_return_type": { base: 7.0, impact_weight: 0.16, default_description: "Alters the data type or structure of a function's return value." },
    "removed_optional_chaining": { base: 6.5, impact_weight: 0.14, default_description: "Removes safe navigation operators, potentially leading to null dereferences." },
    "sync_to_async_change": { base: 9.0, impact_weight: 0.22, default_description: "Changes a synchronous function to an asynchronous one, requiring callers to await." },
    "db_schema_change": { base: 9.5, impact_weight: 0.25, default_description: "Alters database table schemas, potentially breaking ORM or direct queries." },
    "added_type_coercion": { base: 4.0, impact_weight: 0.10, default_description: "Adds implicit or explicit type conversion which might change behavior." },
    "generic_behavioral_change": { base: 5.5, impact_weight: 0.12, default_description: "A general change affecting behavior not covered by specific categories." }
};

const ARCHITECTURAL_ZONE_WEIGHTS = {
    "Database Access Layer": 1.8,
    "Database Access Layer / Models": 1.8,
    "Authentication Layer": 1.5,
    "API Layer / Route Handlers": 1.2,
    "Middleware": 1.0,
    "Service / Business Logic Layer": 1.0,
    "UI Component Layer": 0.5,
    "React Hooks / Shared Logic": 0.8,
    "React Context / State": 1.1,
    "State Management Layer": 1.2,
    "Utility / Shared Logic": 0.7,
    "Configuration / Constants": 0.6,
    "Application Core": 1.0,
    "Worker Layer": 0.9,
    "External/Unresolved": 0.0,
    "Unknown Zone": 0.5
};

// 🎯 Upgrade 5 — Endpoint Criticality Ranking (enhanced for Fix 3)
const ENDPOINT_CRITICALITY_HEURISTICS = [
    { pattern: /\/auth|\/login|\/register|\/logout|\/token/i, level_modifier: 1.5, description: "Authentication/Authorization related endpoint, highly sensitive." },
    { pattern: /\/payment|\/billing|\/checkout|\/transaction/i, level_modifier: 1.8, description: "Payment processing related endpoint, direct revenue impact." },
    { pattern: /\/admin|\/internal/i, level_modifier: 1.2, description: "Admin or internal tool endpoint, potential for privilege escalation or data exposure." },
    { pattern: /\/api\/(?!health)/i, level_modifier: 0.8, description: "General public API endpoint." },
    { pattern: /\/health|\/status/i, level_modifier: 0.1, description: "Health check or status endpoint, low business impact." },
    { pattern: /GET/i, level_modifier: -0.2, description: "Typically read-only operations are less risky than writes." },
    { pattern: /POST|PUT|DELETE|PATCH/i, level_modifier: 0.3, description: "Write operations carry higher risk." }
];

/**
 * Calculates a detailed criticality score for an API endpoint,
 * incorporating business heuristics and caller safety analysis.
 * @param {object} apiNode Details of the API node from the graph.
 * @param {Array<object>} apiCallSafetySummaries Caller safety analysis results for calls made by this API to the target.
 * @returns {{level: string, score: number, reasons: Array<string>}}
 */
function getEndpointCriticality(apiNode, apiCallSafetySummaries) {
    let score = 0;
    let reasons = [];

    // Base score from heuristics (Fix 3: Existing heuristics)
    for (const heuristic of ENDPOINT_CRITICALITY_HEURISTICS) {
        // Check against both route and name (HTTP method)
        if (heuristic.pattern.test(apiNode.route || '') || heuristic.pattern.test(apiNode.name || '')) {
            score += heuristic.level_modifier;
            reasons.push(heuristic.description);
        }
    }

    // Fix 3: Incorporate Caller Safety Analysis
    if (apiCallSafetySummaries && apiCallSafetySummaries.length > 0) {
        const hasUnsafeCall = apiCallSafetySummaries.some(s => s.unhandledErrorProbability > 0.1 || s.unsafeDereferenceLikelihood > 0.1);
        if (hasUnsafeCall) {
            score += 1.0; // Significant risk if any call is unsafe
            reasons.push("Contains calls to target function with potential unhandled errors or null dereferences.");
        }

        const noTryCatchCalls = apiCallSafetySummaries.filter(s => !s.hasTryCatch && s.unhandledErrorProbability > 0.01);
        if (noTryCatchCalls.length > 0) {
            score += noTryCatchCalls.length * 0.5;
            reasons.push(`${noTryCatchCalls.length} calls to target lack try/catch blocks, increasing unhandled exception risk.`);
        }

        const noNullCheckCalls = apiCallSafetySummaries.filter(s => !s.hasNullCheck && !s.isOptionalChaining && s.unsafeDereferenceLikelihood > 0.01);
        if (noNullCheckCalls.length > 0) {
            score += noNullCheckCalls.length * 0.7; // Higher penalty for null checks
            reasons.push(`${noNullCheckCalls.length} calls to target lack null checks, increasing null dereference risk.`);
        }

        const destructuredWithoutGuardCalls = apiCallSafetySummaries.filter(s => s.isDestructuredImmediately && !s.hasNullCheck && !s.isOptionalChaining && s.unsafeDereferenceLikelihood > 0.01);
        if (destructuredWithoutGuardCalls.length > 0) {
            score += destructuredWithoutGuardCalls.length * 0.8; // Even higher penalty
            reasons.push(`${destructuredWithoutGuardCalls.length} calls immediately destructure target's result without null guards.`);
        }
    }

    // Fix 3: Async API endpoint (implies more complex error handling)
    if (apiNode.isAsync) {
        score += 0.2;
        reasons.push("API endpoint is asynchronous, increasing complexity of error propagation.");
    }

    // Map score to level
    let level = "LOW";
    if (score >= 3.0) level = "CRITICAL";
    else if (score >= 1.5) level = "HIGH";
    else if (score >= 0.5) level = "MEDIUM";

    return { level, score: parseFloat(Math.max(0, score).toFixed(2)), reasons };
}


async function run() {
    const startTime = performance.now();
    const projectPath = path.resolve(argv.project);

    // Validate project path exists to prevent ENOENT crashes
    if (!fs.existsSync(projectPath)) {
        console.error(`❌ Error: Project directory does not exist at path:\n  ${projectPath}`);
        console.error(`Please verify the --project path is correct.`);
        process.exit(1);
    }

    const graph = parseToGraph(projectPath);

    // Parse detailed change_type (Fix 2: Behavioral Delta Detection)
    const [rawChangeType, ...behavioralDetailsParts] = argv.change_type.split('::');
    const changeBehavioralDelta = behavioralDetailsParts.join('::') || '';
    const semanticChangeProfile = SEMANTIC_CHANGE_PROFILES[rawChangeType] || SEMANTIC_CHANGE_PROFILES["generic_behavioral_change"];

    const targetNodeId = Object.keys(graph.nodes).find(k =>
        k === argv.target || k.endsWith(`::${argv.target}`) || k.startsWith(`${argv.target} `)
    );

    if (!targetNodeId) {
        console.error(`Error: Target node '${argv.target}' not found in the graph.`);
        process.exit(1);
    }
    const targetNodeDetails = graph.nodes[targetNodeId];
    if (!targetNodeDetails) {
        console.error(`Error: Details for target node '${targetNodeId}' could not be retrieved.`);
        process.exit(1);
    }

    let allImpacts = calculateBlastRadius(graph, targetNodeId);
    const maxDepth = allImpacts.length > 0 ? Math.max(...allImpacts.map(i => i.depth)) : 0;
    let apiImpacts = allImpacts.filter(i => i.type === 'api');

    // 🧪 Upgrade 2 — Caller Safety Scan (GAME CHANGER)
    let callerSafetyAnalysisResults = [];
    if (argv.include_caller_safety_scan) {
        // Filter for actual impact nodes that are functions/APIs and have a file path
        const relevantImpacts = allImpacts.filter(i => (i.type === 'function' || i.type === 'api') && i.file !== 'N/A');
        const uniqueImpactedFiles = [...new Set(relevantImpacts.map(i => path.join(projectPath, i.file)))]; // Get absolute paths of unique files
        const targetFunctionName = targetNodeDetails.name || argv.target;

        for (const fileAbsPath of uniqueImpactedFiles) {
            const safety = scanCallerSafety(fileAbsPath, targetFunctionName);
            callerSafetyAnalysisResults.push(...safety);
        }

        // Augment impacts with safety info
        allImpacts = allImpacts.map(impact => {
            const safetyForThisImpact = callerSafetyAnalysisResults.filter(s =>
                s.file === path.join(projectPath, impact.file) && // Compare absolute paths
                s.callee === targetFunctionName // Ensure it's for the target function
            );
            return { ...impact, caller_safety_details: safetyForThisImpact };
        });
        apiImpacts = apiImpacts.map(impact => {
            const safetyForThisImpact = callerSafetyAnalysisResults.filter(s =>
                s.file === path.join(projectPath, impact.file) && // Compare absolute paths
                s.callee === targetFunctionName
            );
            return { ...impact, caller_safety_details: safetyForThisImpact };
        });
    }

    // 🎯 Upgrade 5 — Endpoint Criticality Ranking (Fix 3: Meaningful Ranking)
    const rankedApiImpacts = apiImpacts.map(api => {
        // Pass relevant caller safety details for this specific API endpoint
        // Filter safety results to only those originating from this API's file
        const apiCallSafetySummaries = callerSafetyAnalysisResults.filter(s => s.file === path.join(projectPath, api.file));
        return {
            ...api,
            criticality: getEndpointCriticality(api, apiCallSafetySummaries)
        };
    }).sort((a, b) => b.criticality.score - a.criticality.score);

    // 🏗 Upgrade 4 — Architectural Awareness Expansion (Zone Weighting)
    const impactedZones = [...new Set(allImpacts.map(i => i.zone).filter(z => z !== "External/Unresolved"))];
    const zoneWeightSum = impactedZones.reduce((sum, zone) => sum + (ARCHITECTURAL_ZONE_WEIGHTS[zone] || 0), 0);

    // Criticality Multiplier (for the target node itself)
    let targetCriticalityMultiplier = 1.0;
    if (argv.criticality_flags) {
        const flags = argv.criticality_flags.split(',').map(f => f.trim());
        for (const flag of flags) {
            if (flag === "public_endpoint") targetCriticalityMultiplier *= 1.5;
            if (flag === "auth_related") targetCriticalityMultiplier *= 1.8;
            if (flag === "payment_related") targetCriticalityMultiplier *= 2.0;
            if (flag === "critical_data_access") targetCriticalityMultiplier *= 1.7;
            if (flag === "internal_tool") targetCriticalityMultiplier *= 0.8;
        }
    }

    const DEPTH_IMPACT_FACTOR = 0.2;
    const ZONE_IMPACT_FACTOR = 0.1;

    let score = semanticChangeProfile.base +
        (apiImpacts.length * semanticChangeProfile.impact_weight) +
        (maxDepth * DEPTH_IMPACT_FACTOR) +
        (zoneWeightSum * ZONE_IMPACT_FACTOR);

    score *= targetCriticalityMultiplier;

    const clampedScore = parseFloat(Math.min(10, score).toFixed(1));

    // 📊 Upgrade 3 — Real Confidence Model
    const parseCoverage = graph.metadata.total_files > 0 ? (1 - (graph.metadata.unresolved_files / graph.metadata.total_files)) : 1;
    const importResolutionCoverage = graph.metadata.total_imports > 0 ? (graph.metadata.resolved_imports / graph.metadata.total_imports) : 1;
    const combinedConfidence = ((parseCoverage + importResolutionCoverage) / 2) * 100;

    // 4️⃣ Improve Import Resolution - Mode: Partial Graph (Fast Analysis)
    let analysisMode = "Full Graph (Comprehensive Analysis)";
    if (graph.metadata.analysis_limit_reached || combinedConfidence < 80) { // If less than 80% confidence
        analysisMode = "Partial Graph (Fast Analysis)";
    }

    // 🔥 Upgrade 6 — Probability Instead of Static Score (Heuristic calculations) (Fix 1 & 2)
    let errorSpikeProbability = 0;
    let nullDereferenceProbability = 0;
    let unhandledExceptionProbability = 0;
    let dataInconsistencyProbability = 0;

    // Aggregate probabilities and their breakdowns from caller safety analysis (Fix 1 & 2)
    const totalCallsAnalyzed = callerSafetyAnalysisResults.length;
    let aggregatedUnsafeDereferenceLikelihood = 0; // Renamed
    let aggregatedUnhandledErrorProb = 0;
    const aggregatedUnsafeDereferenceBreakdowns = []; // Renamed
    const aggregatedUnhandledErrorBreakdowns = [];

    if (totalCallsAnalyzed > 0) {
        callerSafetyAnalysisResults.forEach(s => {
            aggregatedUnsafeDereferenceLikelihood += s.unsafeDereferenceLikelihood; // Renamed
            aggregatedUnhandledErrorProb += s.unhandledErrorProbability;
            if (s.unsafeDereferenceBreakdown) aggregatedUnsafeDereferenceBreakdowns.push(...s.unsafeDereferenceBreakdown); // Renamed
            if (s.unhandledErrorBreakdown) aggregatedUnhandledErrorBreakdowns.push(...s.unhandledErrorBreakdown);
        });
        aggregatedUnsafeDereferenceLikelihood /= totalCallsAnalyzed;
        aggregatedUnhandledErrorProb /= totalCallsAnalyzed;
    }

    // Base probabilities on change type (Fix 2: Behavioral Delta influencing base)
    if (rawChangeType === "added_throw_statement") {
        unhandledExceptionProbability += 0.4;
        errorSpikeProbability += 0.3;
        // If it now throws, and callers don't handle, this is amplified
        unhandledExceptionProbability += aggregatedUnhandledErrorProb * 0.5;
    } else if (rawChangeType === "removed_fallback_behavior" || rawChangeType === "removed_optional_chaining") {
        nullDereferenceProbability += 0.5;
        errorSpikeProbability += 0.2;
        // If fallback removed, and callers expect it or lack null checks, this is amplified
        nullDereferenceProbability += aggregatedUnsafeDereferenceLikelihood * 0.7; // Using renamed likelihood
    } else if (rawChangeType === "stricter_input_constraint") {
        errorSpikeProbability += 0.3; // More 4xx errors
    } else if (rawChangeType === "db_schema_change") {
        dataInconsistencyProbability += 0.6;
        errorSpikeProbability += 0.4;
    } else if (rawChangeType === "changed_return_type") {
        // If return type changed to nullable, amplify null dereference
        if (changeBehavioralDelta.includes("to:nullable")) {
            nullDereferenceProbability += 0.3;
            nullDereferenceProbability += aggregatedUnsafeDereferenceLikelihood * 0.5; // Using renamed likelihood
        }
    } else if (rawChangeType === "sync_to_async_change") {
        unhandledExceptionProbability += 0.3;
        // If callers don't await/catch, this is amplified
        unhandledExceptionProbability += aggregatedUnhandledErrorProb * 0.6;
    }

    // Further adjust based on aggregated caller safety (Fix 1)
    unhandledExceptionProbability = Math.max(unhandledExceptionProbability, aggregatedUnhandledErrorProb);
    nullDereferenceProbability = Math.max(nullDereferenceProbability, aggregatedUnsafeDereferenceLikelihood); // Using renamed likelihood

    // Adjust based on criticality of impacted APIs
    const criticalImpactedApis = rankedApiImpacts.filter(api => api.criticality.level === "CRITICAL" || api.criticality.level === "HIGH");
    if (criticalImpactedApis.length > 0) {
        const criticalityFactor = criticalImpactedApis.length / rankedApiImpacts.length;
        errorSpikeProbability += 0.1 * criticalityFactor;
        unhandledExceptionProbability += 0.1 * criticalityFactor;
        nullDereferenceProbability += 0.1 * criticalityFactor;
    }

    // Cap probabilities at 100% and ensure non-zero if risk exists (Fix 1)
    errorSpikeProbability = Math.min(1, errorSpikeProbability);
    nullDereferenceProbability = Math.min(1, nullDereferenceProbability);
    unhandledExceptionProbability = Math.min(1, unhandledExceptionProbability); // Use the combined value
    dataInconsistencyProbability = Math.min(1, dataInconsistencyProbability);

    // Ensure a minimum non-zero probability if there's any perceived risk, to avoid "breaking trust"
    if (errorSpikeProbability < 0.01 && (aggregatedUnhandledErrorProb > 0 || aggregatedUnsafeDereferenceLikelihood > 0 || apiImpacts.length > 0)) errorSpikeProbability = 0.01;
    if (nullDereferenceProbability < 0.01 && (aggregatedUnsafeDereferenceLikelihood > 0)) nullDereferenceProbability = 0.01;
    if (unhandledExceptionProbability < 0.01 && (aggregatedUnhandledErrorProb > 0)) unhandledExceptionProbability = 0.01;


    // Risk Level (More nuanced definition)
    let riskLevel;
    if (clampedScore >= 9.0 || unhandledExceptionProbability > 0.6 || nullDereferenceProbability > 0.6) {
        riskLevel = "CRITICAL";
    } else if (clampedScore > 7.0 || errorSpikeProbability > 0.4 || unhandledExceptionProbability > 0.3 || nullDereferenceProbability > 0.3) {
        riskLevel = "HIGH";
    } else if (clampedScore > 4.0 || errorSpikeProbability > 0.1) {
        riskLevel = "MEDIUM";
    } else {
        riskLevel = "LOW";
    }

    // 1️⃣ Confidence-Aware Risk - Capping risk if confidence is low
    let finalRiskLevel = riskLevel;
    let confidenceReason = null;
    if (combinedConfidence < 50) {
        // Cap risk at "Moderate – Needs Verification"
        if (finalRiskLevel === "CRITICAL" || finalRiskLevel === "HIGH") {
            finalRiskLevel = "MEDIUM - Needs Verification";
        } else {
            // If it was already MEDIUM or LOW, just add the verification note
            finalRiskLevel += " - Needs Verification";
        }
        confidenceReason = `Low confidence (${combinedConfidence.toFixed(0)}%) due to partial graph analysis. Verification is recommended.`;
    }

    // Prepare context for the AI prompt
    const aiContext = {
        target_node: {
            id: targetNodeId,
            type: targetNodeDetails.type,
            name: targetNodeDetails.name,
            file: targetNodeDetails.file,
            zone: targetNodeDetails.zone,
            parameters: targetNodeDetails.parameters,
            returnType: targetNodeDetails.returnType,
            isAsync: targetNodeDetails.isAsync,
            criticality_flags: argv.criticality_flags ? argv.criticality_flags.split(',') : []
        },
        change_details: {
            raw_type: rawChangeType,
            behavioral_delta: changeBehavioralDelta,
            description: semanticChangeProfile.default_description
        },
        impact_metrics: {
            total_impacted_nodes: allImpacts.length,
            max_propagation_depth: maxDepth,
            api_surface_impact: apiImpacts.length,
            impacted_architectural_zones: impactedZones,
            calculated_raw_score: parseFloat(score.toFixed(2)),
            final_clamped_score: clampedScore,
            risk_level: finalRiskLevel, // Use the confidence-aware final risk level
            confidence: {
                parse_coverage: `${(parseCoverage * 100).toFixed(0)}%`,
                import_resolution_coverage: `${(importResolutionCoverage * 100).toFixed(0)}%`,
                overall: `${(combinedConfidence).toFixed(0)}%`,
                analysis_mode: analysisMode, // Add the analysis mode here
                reason: confidenceReason // Add reason if confidence is low
            },
            estimated_failure_probabilities: {
                error_spike_probability: `${(errorSpikeProbability * 100).toFixed(0)}%`,
                null_dereference_probability: `${(nullDereferenceProbability * 100).toFixed(0)}%`,
                unhandled_exception_probability: `${(unhandledExceptionProbability * 100).toFixed(0)}%`,
                dataInconsistency_probability: `${(dataInconsistencyProbability * 100).toFixed(0)}%`,
                // Sample breakdown for AI to summarize
                null_dereference_breakdown_sample: aggregatedUnsafeDereferenceBreakdowns.slice(0, 5), // Renamed
                unhandled_exception_breakdown_sample: aggregatedUnhandledErrorBreakdowns.slice(0, 5)
            }
        },
        direct_dependents_sample: allImpacts.filter(i => i.depth === 1).slice(0, 5),
        indirect_dependents_sample: allImpacts.filter(i => i.depth > 1).slice(0, 5),
        ranked_api_impacts: rankedApiImpacts.slice(0, 5), // Top 5 risky APIs
        caller_safety_analysis_summary: callerSafetyAnalysisResults
            .filter(s => s.unhandledErrorProbability > 0.05 || s.unsafeDereferenceLikelihood > 0.05) // Filter for higher risk calls (Renamed)
            .slice(0, 5) // Sample unsafe calls for AI context
    };

    // 🔊 Upgrade 7 — “If Deployed Now” Simulation & 🧬 Upgrade 8 — Null Propagation Trace & 🔟 No “Scary Insight”
    const prompt = `You are CodeBuddy, a world-class senior software engineer and coding partner.
You are performing a brutal audit of a code change. Your task is to provide a highly intelligent, predictive, and business-aware impact analysis.
Based on the provided structured context, generate a comprehensive analysis in JSON format.

Context:
${JSON.stringify(aiContext, null, 2)}

Your analysis must include:
1.  "summary": A concise, factual statement summarizing the impact, referencing the change type, API count, depth, and risk level.
2.  "behavioral_delta_interpretation": Based on 'change_details.behavioral_delta', explain what *exactly* changed in the function's behavior (e.g., "This function now explicitly throws an error when X, whereas previously it returned Y.").
3.  "technical_reasoning": An array of bullet points detailing the structural and behavioral reasons for the score. Explain *why* certain zones or depths contribute to risk, and how the behavioral delta propagates.
4.  "caller_safety_analysis_summary": Summarize the findings from the 'caller_safety_analysis_summary' field in the context. Highlight specific types of vulnerabilities found (e.g., "X out of Y callers lack null checks, Z callers have no try/catch."). Also, provide a brief summary of how the deterministic probabilities were derived (e.g., "Unsafe dereference likelihood was calculated from a base of 0.7 due to no explicit null checks, then reduced by 0.5 due to optional chaining, resulting in 0.2") using the provided breakdown samples.
5.  "estimated_failure_probabilities": Reiterate and elaborate on the estimated probabilities provided in the context, explaining the contributing factors from both the change type and caller safety analysis.
6.  "deployment_projection": Simulate what would happen if this change were deployed *now*. Include:
    *   "immediate_effects": What would users or systems experience immediately? (e.g., "Increased 400 errors for invalid input", "Spike in 500 errors due to unhandled exceptions").
    *   "long_term_effects": What are the sustained consequences? (e.g., "Data inconsistency in analytics pipelines", "Degraded user experience for critical workflows").
7.  "scary_insight": Provide one sharp, surprising, and critical insight that highlights a major vulnerability or a hidden risk. This should be an "oh shit" moment.
    *   Example: "4 of the 6 impacted endpoints do not handle null returns from this function. This change increases 500 error probability significantly for critical user-facing APIs."
8.  "simulated_failure_trace": Based on caller safety analysis, describe a *concrete* potential null/error propagation path that could lead to a crash or silent failure. Focus on one high-risk path identified by the safety analysis.
    *   Example: "Input: id = invalid UUID to 'getUserById'. 'getUserById' now returns null. 'POST /api/action-items' (criticality: HIGH) in 'src/routes/actionItems.js' at line 42 will attempt to destructure 'user.id' without a null check, causing a TypeError 'Cannot read properties of null (reading 'id')' which results in a 500 response to the client."
9.  "recommendation": A concise, actionable suggestion based on the predicted risks.
10. "visual_narrative_suggestion": Describe what an ideal visual presentation (e.g., a risk heatmap or layered graph in a demo) would highlight to emphasize the risk and impact, including the most vulnerable paths.

Adhere strictly to the requested JSON format and provide a professional, expert tone.`;

    let aiExplanation = null;

    if (openai) {
        try {
            console.log("Generating AI analysis...");
            const aiRes = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            });
            aiExplanation = JSON.parse(aiRes.choices[0].message.content);
        } catch (error) {
            console.error("AI Analysis failed:", error.message);
            aiExplanation = {
                summary: "AI Analysis failed to generate.",
                technical_reasoning: ["See console for error block."],
                recommendation: "Review the raw JSON output for impact details."
            };
        }
    } else {
        // Only log simple warning to reduce noise
        console.warn("⚠️ AI analysis skipped (OPENAI_API_KEY not set). To enable, set your API key in the environment.");
        aiExplanation = {
            summary: "AI analysis skipped. Please set the OPENAI_API_KEY environment variable.",
            behavioral_delta_interpretation: "N/A",
            technical_reasoning: ["OPENAI_API_KEY was not provided in the environment."],
            caller_safety_analysis_summary: "N/A",
            estimated_failure_probabilities: "N/A",
            deployment_projection: {
                immediate_effects: "Unknown (requires AI)",
                long_term_effects: "Unknown (requires AI)"
            },
            scary_insight: "N/A",
            simulated_failure_trace: "N/A",
            recommendation: "Check the raw report data or add an OpenAI API key.",
            visual_narrative_suggestion: "N/A"
        };
    }

    // Store the full output in a variable
    const finalOutput = {
        analysis_metadata: {
            project: argv.project,
            target: targetNodeId,
            change_type: argv.change_type,
            criticality_flags: argv.criticality_flags ? argv.criticality_flags.split(',') : [],
            time_ms: Math.round(performance.now() - startTime),
            analysis_mode: analysisMode
        },
        impact_summary: {
            total_impacted_nodes: allImpacts.length,
            max_propagation_depth: maxDepth,
            api_surface_impact: apiImpacts.length,
            confidence: {
                parse_coverage: `${(parseCoverage * 100).toFixed(0)}%`,
                import_resolution_coverage: `${(importResolutionCoverage * 100).toFixed(0)}%`,
                overall: `${(combinedConfidence).toFixed(0)}%`,
                reason: confidenceReason
            }
        },
        risk_model: {
            formula_description: "Base + (API_Impacts * Profile_Weight) + (Max_Depth * Depth_Impact_Factor) + (Zone_Weight_Sum * Zone_Impact_Factor) * Target_Criticality_Multiplier",
            change_type_profile: {
                raw_type: rawChangeType,
                behavioral_delta: changeBehavioralDelta,
                description: semanticChangeProfile.default_description,
                base_risk: semanticChangeProfile.base,
                impact_weight: semanticChangeProfile.impact_weight
            },
            architectural_zone_weights_applied: impactedZones.map(zone => ({
                zone: zone,
                weight: ARCHITECTURAL_ZONE_WEIGHTS[zone] || 0
            })),
            target_criticality_multiplier_applied: targetCriticalityMultiplier,
            calculated_raw_score: parseFloat(score.toFixed(2)),
            final_clamped_score: clampedScore,
            risk_level: finalRiskLevel,
            impacted_zones: impactedZones,
            estimated_failure_probabilities: {
                error_spike_probability: `${(errorSpikeProbability * 100).toFixed(0)}%`,
                null_dereference_probability: `${(nullDereferenceProbability * 100).toFixed(0)}%`,
                unhandled_exception_probability: `${(unhandledExceptionProbability * 100).toFixed(0)}%`,
                dataInconsistency_probability: `${(dataInconsistencyProbability * 100).toFixed(0)}%`,
                null_dereference_breakdown_sample: aggregatedUnsafeDereferenceBreakdowns.slice(0, 5),
                unhandled_exception_breakdown_sample: aggregatedUnhandledErrorBreakdowns.slice(0, 5)
            }
        },
        impact_tree: {
            target_node_details: targetNodeDetails,
            direct_dependents: allImpacts.filter(i => i.depth === 1),
            indirect_dependents: allImpacts.filter(i => i.depth > 1)
        },
        ranked_api_impacts: rankedApiImpacts,
        caller_safety_analysis_results: callerSafetyAnalysisResults, // Full results
        ai_analysis: aiExplanation
    };

    // Visualization logic (Step 2, 3, 4)
    if (argv.visualize) {
        const templatePath = path.join(__dirname, 'templates', 'report.html'); // Use __dirname for template location
        if (!fs.existsSync(templatePath)) {
            console.error(`Error: Visualization template not found at ${templatePath}. Please ensure 'templates/report.html' exists next to 'impactRadar.js'.`);
            process.exit(1);
        }

        let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
        const reportJsonString = JSON.stringify(finalOutput); // Use the full finalOutput
        const finalHtml = htmlTemplate.replace('__REPORT_JSON__', reportJsonString);

        const outputPath = path.join(process.cwd(), 'impact-report.html'); // Save to project root
        fs.writeFileSync(outputPath, finalHtml);
        console.log(`Generated visual report: ${outputPath}`);

        const platform = process.platform;
        let command;

        if (platform === 'win32') {
            command = `start "" "${outputPath}"`;
        } else if (platform === 'darwin') {
            command = `open "${outputPath}"`;
        } else {
            command = `xdg-open "${outputPath}"`;
        }

        exec(command);
        console.log(`Report opened successfully in your default browser.`);


    }

    // Original console.log for CLI output
    console.log(JSON.stringify(finalOutput, null, 2));
}

run().catch(console.error);