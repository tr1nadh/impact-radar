import fs from 'fs';
import path from 'path';
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
 * Maps file paths to architectural zones, supporting various frameworks.
 * @param {string} filePath The absolute path of the file.
 * @param {string} projectRoot The absolute root path of the project.
 * @returns {string} The architectural zone.
 */
function getArchitecturalZone(filePath, projectRoot) {
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/'); // Normalize path separators

    if (relPath.includes('src/routes') || relPath.includes('app/api') || relPath.includes('pages/api')) return "API Layer / Route Handlers";
    if (relPath.includes('src/middleware') || relPath.includes('middleware')) return "Middleware"; // Next.js middleware
    if (relPath.includes('src/lib/db') || relPath.includes('lib/db')) return "Database Access Layer";
    if (relPath.includes('src/lib/auth') || relPath.includes('lib/auth')) return "Authentication Layer";
    // UI Component Layer for React/Next.js/Svelte
    if (relPath.includes('src/components') || relPath.includes('components') || relPath.includes('app') || relPath.includes('pages')) return "UI Component Layer";
    if (relPath.includes('src/utils') || relPath.includes('utils')) return "Utility / Shared Logic";
    if (relPath.includes('src/services') || relPath.includes('services')) return "Service / Business Logic Layer";
    if (relPath.includes('src/workers') || relPath.includes('workers')) return "Worker Layer";
    if (relPath.startsWith('src')) return "Application Core"; // Generic src folder
    return "Unknown Zone";
}

const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.svelte'];

/**
 * Resolves an import path to an absolute file path within the project.
 * @param {string} importerPath The absolute path of the file containing the import.
 * @param {string} importedModule The module specifier from the import statement.
 * @param {Set<string>} allProjectFiles A set of all absolute file paths in the project.
 * @param {string} projectRoot The absolute root path of the project.
 * @returns {string|null} The resolved absolute path, or null if not found.
 */
function resolveImportPath(importerPath, importedModule, allProjectFiles, projectRoot) {
    // 1. Handle relative paths (e.g., './module', '../module')
    if (importedModule.startsWith('.') || importedModule.startsWith('/')) {
        let potentialPath = path.resolve(path.dirname(importerPath), importedModule);

        // Try direct path with/without extension
        for (const ext of EXTENSIONS) {
            if (allProjectFiles.has(potentialPath + ext)) {
                return potentialPath + ext;
            }
        }
        if (allProjectFiles.has(potentialPath)) { // Direct file path already exists (e.g., `require('./file.json')`)
            return potentialPath;
        }

        // Try as directory/index.ext (barrel file)
        for (const ext of EXTENSIONS) {
            if (allProjectFiles.has(path.join(potentialPath, `index${ext}`))) {
                return path.join(potentialPath, `index${ext}`);
            }
        }
    }
    // 2. Handle absolute paths within the project (e.g., 'src/components/Button')
    // This is a heuristic for common aliases like 'src/'
    if (importedModule.startsWith('src/') || importedModule.startsWith('app/') || importedModule.startsWith('pages/') || importedModule.startsWith('lib/') || importedModule.startsWith('components/') || importedModule.startsWith('utils/')) {
        let potentialPath = path.join(projectRoot, importedModule);
        for (const ext of EXTENSIONS) {
            if (allProjectFiles.has(potentialPath + ext)) {
                return potentialPath + ext;
            }
        }
        if (allProjectFiles.has(potentialPath)) {
            return potentialPath;
        }
        for (const ext of EXTENSIONS) {
            if (allProjectFiles.has(path.join(potentialPath, `index${ext}`))) {
                return path.join(potentialPath, `index${ext}`);
            }
        }
    }

    // 3. Node modules are not resolved as project files
    return null;
}

/**
 * Extracts route information from a file path, supporting SvelteKit and Next.js.
 * @param {string} filePath The absolute path of the file.
 * @param {string} projectRoot The absolute root path of the project.
 * @returns {string|null} The route string, or null if not a recognized route file.
 */
function getRouteInfo(filePath, projectRoot) {
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/'); // Normalize path separators

    // SvelteKit routes (e.g., src/routes/users/+server.ts)
    if (relPath.includes('src/routes')) {
        const parts = relPath.split('src/routes/')[1];
        return '/' + parts.replace(/\/\+(server|page|layout)\.(js|ts|jsx|tsx|svelte)$/, '').replace(/\/$/, '') || '/';
    }
    // Next.js App Router API routes (e.g., app/api/users/route.ts)
    if (relPath.includes('app/api')) {
        const parts = relPath.split('app/api/')[1];
        return '/' + parts.replace(/\/route\.(js|ts|jsx|tsx)$/, '').replace(/\/$/, '') || '/api/'; // Default to /api/ if root
    }
    // Next.js Pages Router API routes (e.g., pages/api/users.ts)
    if (relPath.includes('pages/api')) {
        const parts = relPath.split('pages/api/')[1];
        return '/' + parts.replace(/\.(js|ts|jsx|tsx)$/, '').replace(/\/$/, '') || '/api/'; // Default to /api/ if root
    }
    // Next.js App Router pages (e.g., app/dashboard/page.tsx)
    if (relPath.includes('app')) {
        const parts = relPath.split('app/')[1];
        return '/' + parts.replace(/\/(page|layout|loading|error)\.(js|ts|jsx|tsx)$/, '').replace(/\/$/, '') || '/';
    }
    // Next.js Pages Router pages (e.g., pages/dashboard.tsx)
    if (relPath.includes('pages')) {
        const parts = relPath.split('pages/')[1];
        return '/' + parts.replace(/\.(js|ts|jsx|tsx)$/, '').replace(/\/$/, '') || '/';
    }

    return null;
}


/**
 * Parses a project to build a dependency graph.
 * @param {string} targetPath Absolute path to the project directory.
 * @param {'FAST' | 'FULL'} graphMode 'FAST' for basic resolution, 'FULL' for deeper traversal and re-export detection.
 * @returns {object} The dependency graph.
 */
export function parseToGraph(targetPath, graphMode = 'FAST') {
    const graph = {
        nodes: {},
        edges: [],
        metadata: {
            unresolved_files: 0,
            total_files: 0,
            total_imports: 0,
            resolved_imports: 0,
            max_depth_detected: 0,
            indirect_nodes_found: 0,
            analysis_limit_reached: false
        }
    };
    const projectRoot = path.resolve(targetPath);

    const allProjectFiles = new Set();
    const fileToRelPathMap = new Map(); // Map absolute path to relative path
    const processedFiles = new Set(); // To prevent infinite loops in FULL mode

    function collectFiles(dir) {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            // FIX: Add '.svelte-kit' to the exclusion list to avoid parsing generated files
            if (file.isDirectory() && ['node_modules', '.git', 'dist', '.svelte-kit'].includes(file.name)) {
                continue;
            }
            if (file.isDirectory()) {
                collectFiles(fullPath); continue;
            }
            if (!file.name.match(/\.(js|ts|jsx|tsx|svelte|mjs|cjs)$/)) continue;

            allProjectFiles.add(fullPath);
            fileToRelPathMap.set(fullPath, path.relative(projectRoot, fullPath));
        }
    }
    collectFiles(projectRoot);

    // Recursive function to process files and their imports
    function processFile(fullPath) {
        if (processedFiles.has(fullPath)) return;
        processedFiles.add(fullPath);

        const relPath = fileToRelPathMap.get(fullPath);
        if (!relPath) { // File exists but isn't in our initial project file list (e.g., dynamically discovered)
            fileToRelPathMap.set(fullPath, path.relative(projectRoot, fullPath));
            allProjectFiles.add(fullPath);
        }

        graph.metadata.total_files++;
        graph.nodes[relPath] = { type: "module", id: relPath, zone: getArchitecturalZone(fullPath, projectRoot) };

        try {
            let code = fs.readFileSync(fullPath, 'utf-8');

            // If it's a Svelte file, extract only the script content for Babel parsing
            if (fullPath.endsWith('.svelte')) {
                code = extractScriptContent(code);
                if (!code.trim()) {
                    // If no script content, there's nothing to analyze for imports/functions
                    return; // Skip Babel parsing for this Svelte file
                }
            }

            const ast = parser.parse(code, {
                sourceType: 'module',
                plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAssertions', 'dynamicImport'] // Removed 'estree'
            });

            babelTraverse(ast, {
                ImportDeclaration(p) {
                    graph.metadata.total_imports++;
                    const importedModule = p.node.source.value;
                    const resolvedAbsPath = resolveImportPath(fullPath, importedModule, allProjectFiles, projectRoot);

                    if (resolvedAbsPath) {
                        const relResolvedPath = fileToRelPathMap.get(resolvedAbsPath);
                        if (relResolvedPath) {
                            graph.metadata.resolved_imports++;
                            graph.edges.push({ from: relPath, to: relResolvedPath, type: "dependency", kind: "import" });
                            // For FULL mode, recursively process imported files
                            if (graphMode === 'FULL' && !processedFiles.has(resolvedAbsPath)) {
                                processFile(resolvedAbsPath);
                            }
                        }
                    } else {
                        // Could not resolve to any known project file (likely node_module or external)
                        graph.edges.push({ from: relPath, to: importedModule, type: "dependency", kind: "import_external" });
                    }
                },
                ExportNamedDeclaration(p) { // Handle re-exports (e.g., `export { A } from './b'`)
                    if (p.node.source) {
                        graph.metadata.total_imports++; // Treat as an import for resolution purposes
                        const reExportedModule = p.node.source.value;
                        const resolvedAbsPath = resolveImportPath(fullPath, reExportedModule, allProjectFiles, projectRoot);

                        if (resolvedAbsPath) {
                            const relResolvedPath = fileToRelPathMap.get(resolvedAbsPath);
                            if (relResolvedPath) {
                                graph.metadata.resolved_imports++;
                                graph.edges.push({ from: relPath, to: relResolvedPath, type: "dependency", kind: "re_export" });
                                if (graphMode === 'FULL' && !processedFiles.has(resolvedAbsPath)) {
                                    processFile(resolvedAbsPath);
                                }
                            }
                        } else {
                            graph.edges.push({ from: relPath, to: reExportedModule, type: "dependency", kind: "re_export_external" });
                        }
                    }
                },
                ExportAllDeclaration(p) { // Handle barrel exports (e.g., `export * from './b'`)
                    if (p.node.source) {
                        graph.metadata.total_imports++; // Treat as an import for resolution purposes
                        const barrelModule = p.node.source.value;
                        const resolvedAbsPath = resolveImportPath(fullPath, barrelModule, allProjectFiles, projectRoot);

                        if (resolvedAbsPath) {
                            const relResolvedPath = fileToRelPathMap.get(resolvedAbsPath);
                            if (relResolvedPath) {
                                graph.metadata.resolved_imports++;
                                graph.edges.push({ from: relPath, to: relResolvedPath, type: "dependency", kind: "barrel_export" });
                                if (graphMode === 'FULL' && !processedFiles.has(resolvedAbsPath)) {
                                    processFile(resolvedAbsPath);
                                }
                            }
                        } else {
                            graph.edges.push({ from: relPath, to: barrelModule, type: "dependency", kind: "barrel_export_external" });
                        }
                    }
                },
                'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression|ObjectMethod'(p) {
                    let name = null;
                    let isApi = false;
                    let nodeId = null;
                    let parameters = [];
                    let returnType = 'any'; // Placeholder for inferred return type
                    let isAsync = p.node.async;

                    if (t.isFunctionDeclaration(p.node) && p.node.id) {
                        name = p.node.id.name;
                    } else if (t.isVariableDeclarator(p.parentPath.node) && t.isIdentifier(p.parentPath.node.id)) {
                        name = p.parentPath.node.id.name;
                    } else if (t.isObjectProperty(p.parentPath.node) && t.isIdentifier(p.parentPath.node.key)) {
                        name = p.parentPath.node.key.name;
                    } else if (t.isObjectMethod(p.node) && t.isIdentifier(p.node.key)) {
                        name = p.node.key.name;
                    }

                    parameters = p.node.params.map(param => {
                        if (t.isIdentifier(param)) return param.name;
                        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) return param.left.name;
                        if (t.isRestElement(param) && t.isIdentifier(param.argument)) return `...${param.argument.name}`;
                        return 'unknown';
                    });

                    const route = getRouteInfo(fullPath, projectRoot); // Pass projectRoot
                    if (name && route) {
                        // Check if function name matches common HTTP methods for API routes
                        isApi = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(name.toUpperCase());
                    }

                    if (isApi) {
                        nodeId = `${name.toUpperCase()} ${route}`;
                        graph.nodes[nodeId] = {
                            type: "api",
                            name: name.toUpperCase(),
                            file: relPath,
                            route: route,
                            zone: getArchitecturalZone(fullPath, projectRoot), // Pass projectRoot
                            parameters,
                            returnType,
                            isAsync
                        };
                    } else if (name) {
                        nodeId = `${relPath}::${name}`;
                        graph.nodes[nodeId] = {
                            type: "function",
                            name,
                            file: relPath,
                            zone: getArchitecturalZone(fullPath, projectRoot), // Pass projectRoot
                            parameters,
                            returnType,
                            isAsync
                        };
                    } else {
                        const parent = p.parentPath.node;
                        if (t.isAssignmentExpression(parent) && t.isMemberExpression(parent.left) && t.isIdentifier(parent.left.property)) {
                            name = parent.left.property.name;
                            nodeId = `${relPath}::${name}`;
                            graph.nodes[nodeId] = {
                                type: "function",
                                name,
                                file: relPath,
                                zone: getArchitecturalZone(fullPath, projectRoot), // Pass projectRoot
                                parameters,
                                returnType,
                                isAsync
                            };
                        } else {
                            return;
                        }
                    }

                    graph.edges.push({ from: relPath, to: nodeId, type: "structural" });

                    p.traverse({
                        CallExpression(innerP) {
                            let calleeName = null;
                            if (t.isIdentifier(innerP.node.callee)) {
                                calleeName = innerP.node.callee.name;
                            } else if (t.isMemberExpression(innerP.node.callee) && t.isIdentifier(innerP.node.callee.property)) {
                                calleeName = innerP.node.callee.property.name;
                            }

                            if (calleeName) {
                                // Add a call edge. For FULL mode, we might want to resolve this calleeName to a nodeId.
                                // This would require a symbol table or more advanced data flow.
                                // For now, we add the raw name.
                                graph.edges.push({ from: nodeId, to: calleeName, type: "dependency", kind: "call", callPath: innerP.node.loc });
                            }
                        }
                    });
                }
            });
        } catch (e) {
            console.warn(`Warning: Error parsing ${fullPath}: ${e.message}`);
            graph.metadata.unresolved_files++;
        }
    }

    // Start processing from all initially collected files
    for (const filePath of allProjectFiles) {
        processFile(filePath);
    }

    // Post-processing for Problem 6: Calculate max depth and indirect nodes
    // FIX: Changed from plain object to Map to prevent prototype pollution issues
    const adjList = new Map();
    graph.edges.forEach(edge => {
        // FIX: Use Map methods (has, set)
        if (!adjList.has(edge.from)) adjList.set(edge.from, []);
        adjList.get(edge.from).push(edge.to);
    });

    // Simple BFS to find max depth (only structural/dependency edges count for depth)
    let maxDepth = 0;
    let indirectNodes = 0;
    const visitedNodes = new Set();
    const queue = [];

    // Find all root nodes (nodes that are not 'to' targets of any edge, or just files)
    const allTargets = new Set(graph.edges.map(e => e.to));
    const rootNodes = new Set(Object.keys(graph.nodes).filter(nodeId => !allTargets.has(nodeId) || graph.nodes[nodeId].type === 'module'));

    // Start BFS from all root files/modules
    for (const nodeId of rootNodes) {
        if (graph.nodes[nodeId]?.type === 'module') { // Only start BFS from actual files for propagation
             queue.push({ id: nodeId, depth: 0 });
             visitedNodes.add(nodeId);
        }
    }

    while (queue.length > 0) {
        const { id, depth } = queue.shift();
        maxDepth = Math.max(maxDepth, depth);

        // FIX: Use Map methods (has, get)
        if (adjList.has(id)) {
            for (const neighbor of adjList.get(id)) {
                if (!visitedNodes.has(neighbor)) {
                    visitedNodes.add(neighbor);
                    if (depth + 1 > 1) { // Indirect node if depth > 1
                        indirectNodes++;
                    }
                    queue.push({ id: neighbor, depth: depth + 1 });
                }
            }
        }
    }
    graph.metadata.max_depth_detected = maxDepth;
    graph.metadata.indirect_nodes_found = indirectNodes;
    graph.metadata.analysis_limit_reached = (graphMode === 'FAST' && graph.metadata.max_depth_detected === 1); // Heuristic for FAST mode

    return graph;
}