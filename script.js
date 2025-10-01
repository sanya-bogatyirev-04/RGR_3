"use strict";

// Data state
const state = {
    nodes: new Set(), // set of node names
    edges: [], // { from, to, weight }
    results: null // computed results cache
};

// DOM refs
const nodesListEl = document.getElementById("nodes-list");
const edgesListEl = document.getElementById("edges-list");
const graphSvg = document.getElementById("graph");
const summaryEl = document.getElementById("summary");
const resultsTableBody = document.querySelector("#results-table tbody");
const nodesTableBody = document.querySelector("#nodes-table tbody");

// Helpers
function normalizeName(name) {
    return String(name || "").trim();
}

function addNode(name) {
    const n = normalizeName(name);
    if (!n) return;
    state.nodes.add(n);
    renderLists();
}

function addEdge(from, to, weight) {
    const f = normalizeName(from);
    const t = normalizeName(to);
    const w = Number(weight);
    if (!f || !t || !Number.isFinite(w) || w < 0) return;
    if (f === t) return;
    state.nodes.add(f);
    state.nodes.add(t);
    state.edges.push({ from: f, to: t, weight: w });
    renderLists();
}

function clearAll() {
    state.nodes = new Set();
    state.edges = [];
    state.results = null;
    renderLists();
    renderResults(null);
}

function renderLists() {
    nodesListEl.innerHTML = "";
    [...state.nodes].sort().forEach(n => {
        const li = document.createElement("li");
        li.textContent = n;
        nodesListEl.appendChild(li);
    });

    edgesListEl.innerHTML = "";
    state.edges.forEach((e, idx) => {
        const li = document.createElement("li");
        li.textContent = `${idx + 1}. ${e.from} → ${e.to} (вес: ${e.weight})`;
        edgesListEl.appendChild(li);
    });
}

// CPM computation for DAG
function computeCPM(nodes, edges) {
    // Build adjacency and indegree
    const nodeList = [...nodes];
    const nameToIndex = new Map(nodeList.map((n, i) => [n, i]));

    const adj = nodeList.map(() => []); // outgoing edges indices
    const indeg = nodeList.map(() => 0);
    edges.forEach((e, ei) => {
        const u = nameToIndex.get(e.from);
        const v = nameToIndex.get(e.to);
        if (u == null || v == null) return;
        adj[u].push(ei);
        indeg[v]++;
    });

    // Kahn topological sort
    const queue = [];
    indeg.forEach((d, i) => { if (d === 0) queue.push(i); });
    const topo = [];
    while (queue.length) {
        const u = queue.shift();
        topo.push(u);
        adj[u].forEach(ei => {
            const v = nameToIndex.get(edges[ei].to);
            indeg[v]--;
            if (indeg[v] === 0) queue.push(v);
        });
    }
    if (topo.length !== nodeList.length) {
        throw new Error("Граф содержит цикл. CPM применим только к ацикличным графам.");
    }

    // Earliest times for nodes (events)
    const E = nodeList.map(() => 0);
    topo.forEach(u => {
        // For each outgoing edge u->v with weight w: E[v] = max(E[v], E[u] + w)
        adj[u].forEach(ei => {
            const e = edges[ei];
            const v = nameToIndex.get(e.to);
            E[v] = Math.max(E[v], E[u] + e.weight);
        });
    });

    const projectDuration = Math.max(...E);

    // Latest times for nodes
    const L = nodeList.map(() => projectDuration);
    for (let k = topo.length - 1; k >= 0; k--) {
        const v = topo[k];
        // If no outgoing, L[v] stays projectDuration
        const outgoing = adj[v];
        if (outgoing.length > 0) {
            let minVal = Infinity;
            outgoing.forEach(ei => {
                const e = edges[ei];
                const w = e.weight;
                const toIdx = nameToIndex.get(e.to);
                minVal = Math.min(minVal, L[toIdx] - w);
            });
            L[v] = Math.min(L[v], minVal);
        }
    }

    // For each edge, compute ES/EF/LS/LF and slack
    const edgeResults = edges.map(e => {
        const u = nameToIndex.get(e.from);
        const v = nameToIndex.get(e.to);
        const ES = E[u];
        const EF = ES + e.weight;
        const LF = L[v];
        const LS = LF - e.weight;
        const slack = LS - ES; // also = LF - EF
        const critical = Math.abs(slack) < 1e-9; // tolerance
        return { ...e, ES, EF, LS, LF, slack, critical };
    });

    // Determine critical paths (trace edges where slack==0)
    // Build adjacency of critical edges by node indices
    const critAdj = nodeList.map(() => []);
    edgeResults.forEach(er => {
        if (er.critical) {
            const u = nameToIndex.get(er.from);
            const v = nameToIndex.get(er.to);
            critAdj[u].push(v);
        }
    });

    // Start nodes: indegree==0; End nodes: E == projectDuration
    const starts = topo.filter(i => {
        // indegree==0 means no incoming edges
        // recompute indegree from edges to be safe
        let d = 0;
        edges.forEach(e => { if (nameToIndex.get(e.to) === i) d++; });
        return d === 0;
    });
    const ends = topo.filter(i => E[i] === projectDuration);

    // DFS enumerate paths of critical edges from starts to ends
    const indexToName = nodeList;
    const criticalPaths = [];
    const path = [];
    const endSet = new Set(ends);

    function dfs(u) {
        path.push(u);
        if (endSet.has(u)) {
            // translate to names
            criticalPaths.push(path.map(idx => indexToName[idx]));
        } else {
            for (const v of critAdj[u]) {
                dfs(v);
            }
        }
        path.pop();
    }
    starts.forEach(s => dfs(s));

    return {
        nodeNames: nodeList,
        E,
        L,
        edges: edgeResults,
        duration: projectDuration,
        criticalPaths
    };
}

// Rendering tables and graph
function renderResults(results) {
    // Clear tables and SVG
    resultsTableBody.innerHTML = "";
    nodesTableBody.innerHTML = "";
    while (graphSvg.firstChild) graphSvg.removeChild(graphSvg.firstChild);
    summaryEl.textContent = "";

    if (!results) return;

    // Tables
    results.edges.forEach((er, idx) => {
        const tr = document.createElement("tr");
        if (er.critical) tr.classList.add("critical");
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${er.from}</td>
            <td>${er.to}</td>
            <td>${fmt(er.weight)}</td>
            <td>${fmt(er.ES)}</td>
            <td>${fmt(er.EF)}</td>
            <td>${fmt(er.LS)}</td>
            <td>${fmt(er.LF)}</td>
            <td>${fmt(er.slack)}</td>
            <td>${er.critical ? "Да" : ""}</td>
        `;
        resultsTableBody.appendChild(tr);
    });

    results.nodeNames.forEach((name, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${name}</td>
            <td>${fmt(results.E[i])}</td>
            <td>${fmt(results.L[i])}</td>
        `;
        nodesTableBody.appendChild(tr);
    });

    // Graph SVG
    drawGraph(results);

    // Summary
    const pathsStr = results.criticalPaths
        .map(p => p.join(" → "))
        .join("; ");
    summaryEl.textContent = `Критический путь(и): ${pathsStr || "—"}. Длительность проекта: ${fmt(results.duration)}`;
}

function fmt(x) { return Number(x).toFixed(3).replace(/\.000$/, ".0").replace(/\.([0-9])00$/, ".$10"); }

function drawGraph(results) {
    const { nodeNames, E, L, edges } = results;

    // Build index maps and adjacency
    const nameToIndex = new Map(nodeNames.map((n, i) => [n, i]));
    const n = nodeNames.length;
    const outAdj = Array.from({ length: n }, () => []);
    const inAdj = Array.from({ length: n }, () => []);
    edges.forEach((er, idx) => {
        const u = nameToIndex.get(er.from);
        const v = nameToIndex.get(er.to);
        if (u == null || v == null) return;
        outAdj[u].push(v);
        inAdj[v].push(u);
    });

    // Integer layers via longest path with unit weights (for layout only)
    const indeg = inAdj.map(arr => arr.length);
    const queue = [];
    indeg.forEach((d, i) => { if (d === 0) queue.push(i); });
    const topo = [];
    while (queue.length) {
        topo.push(queue.shift());
        const u = topo[topo.length - 1];
        outAdj[u].forEach(v => { indeg[v]--; if (indeg[v] === 0) queue.push(v); });
    }
    const layerIndex = Array.from({ length: n }, () => 0);
    topo.forEach(u => {
        outAdj[u].forEach(v => {
            layerIndex[v] = Math.max(layerIndex[v], layerIndex[u] + 1);
        });
    });

    // Group nodes by layer
    const layers = [];
    for (let i = 0; i < n; i++) {
        const li = layerIndex[i];
        if (!layers[li]) layers[li] = [];
        layers[li].push(i);
    }

    // Barycentric ordering sweeps to reduce crossings
    function orderByBarycenter(currentLayer, neighborLayer, neighborAdjGetter) {
        const orderMap = new Map();
        neighborLayer.forEach((nodeId, idx) => orderMap.set(nodeId, idx));
        const items = currentLayer.map(nodeId => {
            const neighbors = neighborAdjGetter(nodeId);
            if (neighbors.length === 0) return { nodeId, key: Infinity };
            const sum = neighbors.reduce((acc, v) => acc + (orderMap.get(v) ?? 0), 0);
            return { nodeId, key: sum / neighbors.length };
        });
        items.sort((a, b) => a.key - b.key);
        return items.map(it => it.nodeId);
    }

    for (let sweep = 0; sweep < 4; sweep++) {
        // top-down
        for (let i = 1; i < layers.length; i++) {
            layers[i] = orderByBarycenter(layers[i], layers[i - 1], (nodeId) => inAdj[nodeId]);
        }
        // bottom-up
        for (let i = layers.length - 2; i >= 0; i--) {
            layers[i] = orderByBarycenter(layers[i], layers[i + 1], (nodeId) => outAdj[nodeId]);
        }
    }

    // Layout constants
    const margin = { left: 60, top: 40, right: 60, bottom: 40 };
    const layerGapX = 180;
    const nodeGapY = 90;
    const r = 24;

    const width = margin.left + margin.right + layerGapX * Math.max(0, layers.length - 1) + 200;
    const maxNodesInLayer = Math.max(1, ...layers.map(arr => (arr ? arr.length : 0)));
    const height = margin.top + margin.bottom + nodeGapY * (maxNodesInLayer - 1) + 200;

    graphSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Arrow marker (edge and critical edge colors via CSS var)
    const defs = svgEl("defs");
    const marker = svgEl("marker", {
        id: "arrow", viewBox: "0 0 10 10", refX: 10, refY: 5,
        markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse"
    });
    const markerPath = svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: getCssVar("--edge") });
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    graphSvg.appendChild(defs);

    // Compute positions according to ordered layers
    const positions = new Map();
    layers.forEach((layerNodes, li) => {
        const totalHeight = nodeGapY * Math.max(0, (layerNodes?.length || 1) - 1);
        layerNodes.forEach((nodeId, idx) => {
            const x = margin.left + li * layerGapX;
            const y = margin.top + (height - margin.top - margin.bottom - totalHeight) / 2 + idx * nodeGapY;
            positions.set(nodeNames[nodeId], { x, y });
        });
    });

    // Helper to compute edge-specific offset to separate parallel/nearby edges
    const edgeCountFrom = new Map();
    const edgeSeqFrom = new Map();
    edges.forEach(er => {
        const key = `${er.from}`;
        edgeCountFrom.set(key, (edgeCountFrom.get(key) || 0) + 1);
    });
    const offsetCache = new Map();
    function edgeOffset(er) {
        const key = `${er.from}|${er.to}|${er.weight}`;
        if (offsetCache.has(key)) return offsetCache.get(key);
        const seqKey = `${er.from}`;
        const used = (edgeSeqFrom.get(seqKey) || 0);
        edgeSeqFrom.set(seqKey, used + 1);
        const total = edgeCountFrom.get(seqKey) || 1;
        // spread in range [-12, 12]
        const off = total > 1 ? ((used - (total - 1) / 2) * (24 / Math.max(1, total - 1))) : 0;
        offsetCache.set(key, off);
        return off;
    }

    // Draw edges (curved to avoid intersection and node overlap)
    edges.forEach(er => {
        const p1 = positions.get(er.from);
        const p2 = positions.get(er.to);
        if (!p1 || !p2) return;
        const off = edgeOffset(er);
        const startDir = { x: 1, y: 0 };
        const endDir = { x: -1, y: 0 };
        const sx = p1.x + r;
        const sy = p1.y + off;
        const ex = p2.x - r;
        const ey = p2.y + off;
        const cx1 = sx + (Math.max(60, (ex - sx) / 3));
        const cy1 = sy;
        const cx2 = ex - (Math.max(60, (ex - sx) / 3));
        const cy2 = ey;

        const path = svgEl("path", {
            d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
            class: `edge${er.critical ? " critical" : ""}`
        });
        graphSvg.appendChild(path);

        // Place labels near mid of curve
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2 - 8;
        const tx = mx;
        const ty1 = my;
        const ty2 = my + 14;
        const label = svgEl("text", { x: tx, y: ty1, class: "edge-label" });
        label.textContent = `${fmt(er.weight)}`;
        graphSvg.appendChild(label);
        const times = svgEl("text", { x: tx, y: ty2, class: "edge-times" });
        times.textContent = `ES ${fmt(er.ES)} | EF ${fmt(er.EF)} | LS ${fmt(er.LS)} | LF ${fmt(er.LF)}`;
        graphSvg.appendChild(times);
    });

    // Draw nodes on top
    nodeNames.forEach((name, i) => {
        const pos = positions.get(name);
        if (!pos) return;
        const { x, y } = pos;
        const g = svgEl("g", { class: "node" });
        const circle = svgEl("circle", { cx: x, cy: y, r });
        g.appendChild(circle);

        const nameText = svgEl("text", { x, y, class: "name" });
        nameText.textContent = name;
        g.appendChild(nameText);

        const eText = svgEl("text", { x: x - r - 8, y: y - r - 6, class: "small" });
        eText.textContent = `E ${fmt(E[i])}`;
        g.appendChild(eText);

        const lText = svgEl("text", { x: x + r + 8, y: y - r - 6, class: "small" });
        lText.textContent = `L ${fmt(L[i])}`;
        g.appendChild(lText);

        graphSvg.appendChild(g);
    });
}

function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function svgEl(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    if (attrs) {
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    }
    return el;
}

// Event bindings
document.getElementById("node-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = document.getElementById("node-name");
    addNode(input.value);
    input.value = "";
});

document.getElementById("edge-form").addEventListener("submit", e => {
    e.preventDefault();
    const from = document.getElementById("edge-from");
    const to = document.getElementById("edge-to");
    const w = document.getElementById("edge-weight");
    addEdge(from.value, to.value, w.value);
    // keep values to ease input of chains
});

document.getElementById("btn-clear").addEventListener("click", () => {
    clearAll();
});

document.getElementById("btn-compute").addEventListener("click", () => {
    try {
        if (state.nodes.size === 0) throw new Error("Добавьте хотя бы одну вершину.");
        if (state.edges.length === 0) throw new Error("Добавьте хотя бы одну дугу.");
        const results = computeCPM(state.nodes, state.edges);
        state.results = results;
        renderResults(results);
    } catch (err) {
        alert(err.message || String(err));
    }
});

document.getElementById("btn-sample").addEventListener("click", () => {
    // Example DAG
    clearAll();
    const names = ["A","B","C","D","E","F","G"]; // will be auto-added by edges too
    names.forEach(addNode);
    addEdge("A","B", 3);
    addEdge("A","C", 2);
    addEdge("B","D", 2);
    addEdge("C","D", 4);
    addEdge("C","E", 2);
    addEdge("D","F", 3);
    addEdge("E","F", 2);
    addEdge("F","G", 3);
});

// Initial render
renderLists();
renderResults(null);



