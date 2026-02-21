import fs from 'fs';
import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';

const babelTraverse = _traverse.default || _traverse;

/**
 * Extracts content from <script> tags within a Svelte file.
 * This allows Babel to parse only the JavaScript/TypeScript logic.
 * @param {string} svelteCode The full content of a .svelte file.
 * @returns {string} Concatenated content of all <script> blocks.
 */
function extractScriptContent(svelteCode) {
    // Regex to find <script> tags, optionally with 'lang="ts"'
    const scriptRegex = /<script(?:\s+lang=["']ts["'])?>(.*?)<\/script>/gs;
    let match;
    let scriptContent = '';
    // Collect all script blocks
    while ((match = scriptRegex.exec(svelteCode)) !== null) {
        scriptContent += match[1] + '\n';
    }
    return scriptContent;
}

/**
 * Calculates safety probabilities based on detected safety mechanisms.
 * @param {object} safetyFlags Object containing boolean safety flags.
 * @param {boolean} safetyFlags.hasTryCatch
 * @param {boolean} safetyFlags.hasNullCheck
 * @param {boolean} safetyFlags.isDestructuredImmediately
 * @param {boolean} safetyFlags.assumedExists
 * @param {boolean} safetyFlags.isAsyncCall - True if the call expression is within an async function.
 * @param {boolean} safetyFlags.isOptionalChaining - True if the call expression is part of optional chaining.
 * @returns {{unsafeDereferenceLikelihood: number, unhandledErrorProbability: number, unsafeDereferenceBreakdown: string[], unhandledErrorBreakdown: string[]}}
 */
function calculateSafetyProbabilities({ hasTryCatch, hasNullCheck, isDestructuredImmediately, assumedExists, isAsyncCall, isOptionalChaining }) {
    let unsafeDereferenceLikelihood = 0;
    let unhandledErrorProbability = 0;
    const unsafeDereferenceBreakdown = [];
    const unhandledErrorBreakdown = [];

    // --- Unsafe Dereference Likelihood (formerly Null Crash Probability) ---
    // Base: High if no explicit null check or optional chaining
    if (!hasNullCheck && !isOptionalChaining) {
        unsafeDereferenceLikelihood = 0.7; // High base risk if no explicit guard
        unsafeDereferenceBreakdown.push("Base: No explicit null check or optional chaining found (+0.7)");
    } else {
        unsafeDereferenceLikelihood = 0.1; // Low base risk if a check exists
        unsafeDereferenceBreakdown.push("Base: Null check or optional chaining found (+0.1)");
    }

    if (isDestructuredImmediately && !hasNullCheck && !isOptionalChaining) {
        unsafeDereferenceLikelihood += 0.2; // Higher risk if destructured without guard
        unsafeDereferenceBreakdown.push("Condition: Destructuring without null guard (+0.2)");
    }

    if (assumedExists && !hasNullCheck && !isOptionalChaining) {
        unsafeDereferenceLikelihood += 0.15; // Assuming existence without checks is risky
        unsafeDereferenceBreakdown.push("Condition: Assumed existence without checks (+0.15)");
    }

    if (hasNullCheck) {
        unsafeDereferenceLikelihood = Math.max(0, unsafeDereferenceLikelihood - 0.5); // Significant reduction
        unsafeDereferenceBreakdown.push("Mitigation: Explicit null check (-0.5)");
    }
    if (isOptionalChaining) {
        unsafeDereferenceLikelihood = Math.max(0, unsafeDereferenceLikelihood - 0.4); // Significant reduction
        unsafeDereferenceBreakdown.push("Mitigation: Optional chaining (-0.4)");
    }

    // --- Unhandled Error Probability ---
    // Base: High if no try/catch
    if (!hasTryCatch) {
        unhandledErrorProbability = 0.6; // High base risk
        unhandledErrorBreakdown.push("Base: No try/catch block found (+0.6)");
    } else {
        unhandledErrorProbability = 0.1; // Low base risk
        unhandledErrorBreakdown.push("Base: Try/catch block found (+0.1)");
    }

    if (isAsyncCall && !hasTryCatch) {
        unhandledErrorProbability += 0.2; // Async without catch is higher risk for unhandled rejections
        unhandledErrorBreakdown.push("Condition: Async call without try/catch (+0.2)");
    }

    // Ensure probabilities are within [0, 1]
    unsafeDereferenceLikelihood = Math.max(0, Math.min(1, unsafeDereferenceLikelihood));
    unhandledErrorProbability = Math.max(0, Math.min(1, unhandledErrorProbability));

    // Special case: if all safety mechanisms are perfectly in place, risk can be effectively zero
    // This is a final override to ensure extreme safety results in very low risk.
    if (hasNullCheck && !isDestructuredImmediately && !assumedExists && !isAsyncCall && hasTryCatch && isOptionalChaining) {
        unsafeDereferenceLikelihood = 0.00;
        unhandledErrorProbability = 0.00;
        unsafeDereferenceBreakdown.push("Overall: All safety mechanisms present, minimal risk (0.00)");
        unhandledErrorBreakdown.push("Overall: All safety mechanisms present, minimal risk (0.00)");
    } else if (hasNullCheck && !isDestructuredImmediately && !assumedExists && !isAsyncCall && hasTryCatch) {
        // If no optional chaining but other checks are perfect
        unsafeDereferenceLikelihood = Math.min(unsafeDereferenceLikelihood, 0.01); // Minimal residual risk
        unhandledErrorProbability = Math.min(unhandledErrorProbability, 0.01); // Minimal residual risk
        if (!unsafeDereferenceBreakdown.some(b => b.includes("Minimal residual risk"))) unsafeDereferenceBreakdown.push("Overall: All major safety mechanisms present, minimal residual risk (0.01)");
        if (!unhandledErrorBreakdown.some(b => b.includes("Minimal residual risk"))) unhandledErrorBreakdown.push("Overall: All major safety mechanisms present, minimal residual risk (0.01)");
    }


    return {
        unsafeDereferenceLikelihood: parseFloat(unsafeDereferenceLikelihood.toFixed(2)),
        unhandledErrorProbability: parseFloat(unhandledErrorProbability.toFixed(2)),
        unsafeDereferenceBreakdown,
        unhandledErrorBreakdown
    };
}


/**
 * Scans the code of a given file for calls to a specific target function/API
 * and analyzes the safety mechanisms around those calls.
 * @param {string} filePath Absolute path to the file to scan.
 * @param {string} targetFunctionName The simple name of the function being called (e.g., 'getUserById').
 * @returns {Array<object>} An array of safety analyses for each relevant call site.
 */
export function scanCallerSafety(filePath, targetFunctionName) {
    const safetyAnalyses = [];
    if (!fs.existsSync(filePath)) {
        return [{
            file: filePath,
            targetFunctionName: targetFunctionName,
            analysis: "File not found for safety scan."
        }];
    }

    try {
        let code = fs.readFileSync(filePath, 'utf-8');

        // If it's a Svelte file, extract only the script content for Babel parsing
        if (filePath.endsWith('.svelte')) {
            code = extractScriptContent(code);
            if (!code.trim()) {
                // If no script content, there's nothing to analyze for calls
                return [];
            }
        }

        const ast = parser.parse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAssertions', 'dynamicImport'] // Removed 'estree'
        });

        babelTraverse(ast, {
            CallExpression(p) {
                let calleeName = null;
                if (t.isIdentifier(p.node.callee)) {
                    calleeName = p.node.callee.name;
                } else if (t.isMemberExpression(p.node.callee) && t.isIdentifier(p.node.callee.property)) {
                    calleeName = p.node.callee.property.name;
                }

                // Check if this call expression is for our target function
                if (calleeName === targetFunctionName) {
                    let hasTryCatch = false;
                    let hasNullCheck = false;
                    let isDestructuredImmediately = false;
                    let assumedExists = false; // Directly used without checks
                    let isAsyncCall = false; // Is this call within an async function?
                    let isOptionalChaining = false; // Is this call part of optional chaining?

                    const originalCallExpressionNode = p.node; // Store the original CallExpression

                    // 1. Check for optional chaining on the result of this call
                    // This covers cases like `myFunc()?.prop` or `(await myFunc())?.prop`
                    // The parent of the CallExpression could be an OptionalMemberExpression or OptionalCallExpression
                    if (p.parentPath && (t.isOptionalMemberExpression(p.parentPath.node) || t.isOptionalCallExpression(p.parentPath.node))) {
                        isOptionalChaining = true;
                        hasNullCheck = true; // Optional chaining acts as a null check
                    }

                    // 2. Determine the "result" identifier/expression for subsequent checks
                    let resultIdentifierName = null;
                    let expressionToTrack = originalCallExpressionNode; // Default to the call expression itself

                    // If the call expression is part of an AwaitExpression, the AwaitExpression is the "result"
                    if (t.isAwaitExpression(p.parentPath.node) && p.parentPath.node.argument === originalCallExpressionNode) {
                        expressionToTrack = p.parentPath.node; // Track the AwaitExpression
                        // If the AwaitExpression is then assigned to a variable
                        if (t.isVariableDeclarator(p.parentPath.parentPath.node) && p.parentPath.parentPath.node.init === expressionToTrack) {
                            if (t.isIdentifier(p.parentPath.parentPath.node.id)) {
                                resultIdentifierName = p.parentPath.parentPath.node.id.name;
                            } else if (t.isObjectPattern(p.parentPath.parentPath.node.id) || t.isArrayPattern(p.parentPath.parentPath.node.id)) {
                                isDestructuredImmediately = true;
                            }
                        }
                    } else if (t.isVariableDeclarator(p.parentPath.node) && p.parentPath.node.init === originalCallExpressionNode) {
                        // Case: const result = targetFunc();
                        if (t.isIdentifier(p.parentPath.node.id)) {
                            resultIdentifierName = p.parentPath.node.id.name;
                        } else if (t.isObjectPattern(p.parentPath.node.id) || t.isArrayPattern(p.parentPath.node.id)) {
                            isDestructuredImmediately = true;
                        }
                    }

                    // Traverse up the AST from the CallExpression's parent (or the AwaitExpression's parent)
                    // Start from the parent of the expression being tracked
                    let currentPath = p.parentPath;
                    if (expressionToTrack === p.parentPath.node) { // If it was an AwaitExpression, start from its parent
                        currentPath = p.parentPath.parentPath;
                    }

                    while (currentPath) {
                        // Check for try/catch
                        if (t.isTryStatement(currentPath.node)) {
                            hasTryCatch = true;
                        }

                        // Check if the current function is async
                        if ((t.isFunctionDeclaration(currentPath.node) || t.isArrowFunctionExpression(currentPath.node) || t.isFunctionExpression(currentPath.node) || t.isObjectMethod(currentPath.node)) && currentPath.node.async) {
                            isAsyncCall = true;
                        }

                        // Check for null/undefined checks on the result
                        if (!hasNullCheck) { // Only check if not already found by optional chaining
                            const nodeToCheck = currentPath.node;

                            const isTargetExpression = (expr) => {
                                // Check if the expression is our resultIdentifier, or the original callExpressionNode itself
                                if (resultIdentifierName && t.isIdentifier(expr) && expr.name === resultIdentifierName) return true;
                                if (expr === originalCallExpressionNode) return true;
                                if (expr === expressionToTrack && t.isAwaitExpression(expr)) return true;
                                return false;
                            };

                            // Look for if (resultVar), if (resultVar !== null), resultVar && ...
                            if (t.isIfStatement(nodeToCheck) || t.isConditionalExpression(nodeToCheck)) {
                                const testNode = nodeToCheck.test;

                                // Binary expressions: `result !== null`, `result == undefined`
                                if (t.isBinaryExpression(testNode)) {
                                    if ((t.isNullLiteral(testNode.right) || (t.isIdentifier(testNode.right) && testNode.right.name === 'undefined')) && isTargetExpression(testNode.left)) {
                                        hasNullCheck = true;
                                    } else if ((t.isNullLiteral(testNode.left) || (t.isIdentifier(testNode.left) && testNode.left.name === 'undefined')) && isTargetExpression(testNode.right)) {
                                        hasNullCheck = true;
                                    }
                                }
                                // Unary expressions: `!result`
                                else if (t.isUnaryExpression(testNode, { operator: '!' }) && isTargetExpression(testNode.argument)) {
                                    hasNullCheck = true;
                                }
                                // Logical expressions: `result && result.prop` (short-circuiting implies null check)
                                else if (t.isLogicalExpression(testNode, { operator: '&&' }) && isTargetExpression(testNode.left)) {
                                    hasNullCheck = true;
                                }
                                // Direct truthiness check: `if (result)`
                                else if (isTargetExpression(testNode)) {
                                    hasNullCheck = true;
                                }
                            }
                        }

                        // Move up the path
                        currentPath = currentPath.parentPath;
                    }

                    // Heuristic for assumed existence: if no null check, no try/catch, no destructuring, and no optional chaining
                    if (!hasNullCheck && !hasTryCatch && !isDestructuredImmediately && !isOptionalChaining) {
                        assumedExists = true;
                    }

                    const { unsafeDereferenceLikelihood, unhandledErrorProbability, unsafeDereferenceBreakdown, unhandledErrorBreakdown } = calculateSafetyProbabilities({
                        hasTryCatch,
                        hasNullCheck,
                        isDestructuredImmediately,
                        assumedExists,
                        isAsyncCall,
                        isOptionalChaining
                    });

                    safetyAnalyses.push({
                        file: filePath,
                        line: p.node.loc?.start.line,
                        column: p.node.loc?.start.column,
                        callee: calleeName,
                        hasTryCatch,
                        hasNullCheck,
                        isDestructuredImmediately,
                        assumedExists,
                        isAsyncCall,
                        isOptionalChaining,
                        unsafeDereferenceLikelihood, // Renamed
                        unhandledErrorProbability,
                        unsafeDereferenceBreakdown, // Renamed
                        unhandledErrorBreakdown
                    });
                }
            }
        });
    } catch (e) {
        console.warn(`Warning: Error scanning caller safety for ${filePath}: ${e.message}`);
        safetyAnalyses.push({
            file: filePath,
            analysis: `Error during safety scan: ${e.message}`
        });
    }
    return safetyAnalyses;
}