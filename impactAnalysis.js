export function calculateBlastRadius(graph, targetId) {
    const impacts = [];
    const visited = new Set();
    const queue = [{ id: targetId, depth: 0, chain: [targetId] }];

    // Build Adjacency List for Reverse Functional Traversal (Dependents)
    // FIX: Changed from plain object to Map to prevent prototype pollution issues
    const adj = new Map();

    graph.edges.forEach(edge => {
        // Only consider 'dependency' edges for blast radius, not 'structural' (file-to-function)
        if (edge.type === 'structural') return;

        const calleeId = edge.to;
        const callerId = edge.from;

        // Defensive check, though graphParser should ideally ensure calleeId is a valid string
        if (calleeId === null || calleeId === undefined) {
             console.warn(`Skipping edge with null/undefined calleeId in blast radius calculation: ${JSON.stringify(edge)}`);
             return;
        }

        // FIX: Use Map methods (has, set, get)
        if (!adj.has(calleeId)) adj.set(calleeId, new Set());
        adj.get(calleeId).add(callerId);

        // Also add short name for resolution, as graphParser might not always resolve to full nodeId
        const shortName = calleeId.includes('::') ? calleeId.split('::')[1] : calleeId;
        if (shortName !== calleeId) {
            // FIX: Use Map methods (has, set, get)
            if (!adj.has(shortName)) adj.set(shortName, new Set());
            adj.get(shortName).add(callerId);
        }
    });

    visited.add(targetId);

    while (queue.length > 0) {
        const { id, depth, chain } = queue.shift();

        const dependents = new Set();
        // FIX: Use Map methods (has, get)
        if (adj.has(id)) {
            adj.get(id).forEach(dep => dependents.add(dep));
        }
        const shortId = id.includes('::') ? id.split('::')[1] : id;
        // FIX: Use Map methods (has, get)
        if (shortId !== id && adj.has(shortId)) {
            adj.get(shortId).forEach(dep => dependents.add(dep));
        }

        for (const depId of dependents) {
            if (!visited.has(depId)) {
                visited.add(depId);
                const node = graph.nodes[depId];
                const newChain = [...chain, depId];
                
                const impact = {
                    id: depId,
                    type: node?.type || "unresolved",
                    zone: node?.zone || "External/Unresolved",
                    depth: depth + 1,
                    chain: newChain.join(' ➔ '),
                    file: node?.file || 'N/A',
                    name: node?.name || depId
                };

                impacts.push(impact);
                queue.push({ id: depId, depth: depth + 1, chain: newChain });
            }
        }
    }
    return impacts;
}