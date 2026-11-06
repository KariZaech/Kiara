(function (root) {
  "use strict";

  const EXACT_LIMIT = 14;

  function shortestPaths(graph, start, reverse = false) {
    const distances = new Map([[start, 0]]);
    const previous = new Map();
    const queue = new MinHeap();
    queue.push({ node: start, distance: 0 });

    while (queue.size) {
      const current = queue.pop();
      if (current.distance !== distances.get(current.node)) continue;
      for (const edge of graph.adjacency.get(current.node) || []) {
        const next = edge.other;
        const cost = reverse ? edge.reverse : edge.forward;
        const candidate = current.distance + cost;
        if (candidate < (distances.get(next) ?? Infinity)) {
          distances.set(next, candidate);
          previous.set(next, { node: current.node, edgeId: edge.id, from: current.node, to: next, time: cost });
          queue.push({ node: next, distance: candidate });
        }
      }
    }

    return { distances, previous };
  }

  function makeGraph(network) {
    const nodes = network.nodes.map((node) => node.id);
    const nodeSet = new Set(nodes);
    const adjacency = new Map(nodes.map((id) => [id, []]));
    for (const edge of network.edges) {
      if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
        throw new Error(`Trail "${edge.name || edge.id}" refers to a missing point.`);
      }
      if (!Number.isFinite(edge.forward) || edge.forward <= 0 || !Number.isFinite(edge.reverse) || edge.reverse <= 0) {
        throw new Error(`Trail "${edge.name || edge.id}" must have positive travel times in both directions.`);
      }
      adjacency.get(edge.from).push({ id: edge.id, other: edge.to, forward: edge.forward, reverse: edge.reverse });
      adjacency.get(edge.to).push({ id: edge.id, other: edge.from, forward: edge.reverse, reverse: edge.forward });
    }
    const required = network.edges.filter((edge) => edge.required);
    return { nodes, edges: network.edges, adjacency, required };
  }

  function reconstructPath(previous, start, end) {
    if (start === end) return [];
    const path = [];
    let node = end;
    while (node !== start) {
      const step = previous.get(node);
      if (!step) return null;
      path.push(step);
      node = step.from;
    }
    path.reverse();
    return path;
  }

  function runExact(graph) {
    const nodeIndex = new Map(graph.nodes.map((id, index) => [id, index]));
    const edgeIndex = new Map(graph.required.map((edge, index) => [edge.id, index]));
    const maskCount = 1 << graph.required.length;
    const fullMask = maskCount - 1;
    const stateCount = graph.nodes.length * maskCount;
    const distances = new Float64Array(stateCount);
    distances.fill(Infinity);
    const previous = new Int32Array(stateCount);
    previous.fill(-1);
    const previousEdge = new Int32Array(stateCount);
    previousEdge.fill(-1);
    const previousDirection = new Int8Array(stateCount);
    const queue = new MinHeap();

    graph.nodes.forEach((id, index) => {
      const state = index;
      distances[state] = 0;
      queue.push({ state, distance: 0 });
    });

    let finishState = -1;
    while (queue.size) {
      const current = queue.pop();
      if (current.distance !== distances[current.state]) continue;
      const mask = Math.floor(current.state / graph.nodes.length);
      const nodePosition = current.state % graph.nodes.length;
      if (mask === fullMask) {
        finishState = current.state;
        break;
      }
      const node = graph.nodes[nodePosition];
      for (const edge of graph.adjacency.get(node)) {
        const nextPosition = nodeIndex.get(edge.other);
        const serviceIndex = edgeIndex.get(edge.id);
        const nextMask = serviceIndex === undefined ? mask : mask | (1 << serviceIndex);
        const nextState = nextMask * graph.nodes.length + nextPosition;
        const candidate = current.distance + edge.forward;
        if (candidate < distances[nextState]) {
          distances[nextState] = candidate;
          previous[nextState] = current.state;
          previousEdge[nextState] = graph.edgesById.get(edge.id);
          previousDirection[nextState] = edge.forward === graph.edgesById.get(edge.id).forward ? 0 : 1;
          queue.push({ state: nextState, distance: candidate });
        }
      }
    }

    if (finishState < 0) {
      throw new Error("The required trails cannot all be reached through this network. Add a connecting trail or check the endpoints.");
    }

    const route = [];
    let state = finishState;
    while (previous[state] !== -1) {
      const edge = graph.edges[previousEdge[state]];
      const fromPosition = previous[state] % graph.nodes.length;
      const toPosition = state % graph.nodes.length;
      route.push({
        edgeId: edge.id,
        from: graph.nodes[fromPosition],
        to: graph.nodes[toPosition],
        time: previousDirection[state] === 0 ? edge.forward : edge.reverse
      });
      state = previous[state];
    }
    route.reverse();
    return { route, total: distances[finishState], exact: true };
  }

  function runHeuristic(graph) {
    const edges = graph.required;
    const candidates = edges
      .map((edge) => ({ edge, score: Math.min(edge.forward, edge.reverse) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.min(10, edges.length));
    let best = null;

    for (const { edge: first } of candidates) {
      for (const orientation of [
        { from: first.from, to: first.to, time: first.forward },
        { from: first.to, to: first.from, time: first.reverse }
      ]) {
        const route = [{ edgeId: first.id, from: orientation.from, to: orientation.to, time: orientation.time }];
        const covered = new Set([first.id]);
        let current = orientation.to;
        let total = orientation.time;
        let possible = true;

        while (covered.size < edges.length) {
          const paths = shortestPaths(graph, current);
          let choice = null;
          for (const edge of edges) {
            if (covered.has(edge.id)) continue;
            const options = [
              { from: edge.from, to: edge.to, time: edge.forward },
              { from: edge.to, to: edge.from, time: edge.reverse }
            ];
            for (const option of options) {
              const approach = paths.distances.get(option.from);
              if (approach === undefined) continue;
              const score = approach + option.time;
              if (!choice || score < choice.score) {
                choice = { edge, option, score, path: reconstructPath(paths.previous, current, option.from) };
              }
            }
          }
          if (!choice || !choice.path) {
            possible = false;
            break;
          }
          route.push(...choice.path);
          total += choice.score;
          route.push({ edgeId: choice.edge.id, from: choice.option.from, to: choice.option.to, time: choice.option.time });
          covered.add(choice.edge.id);
          current = choice.option.to;
        }

        if (possible && (!best || total < best.total)) best = { route, total, exact: false };
      }
    }
    if (!best) {
      throw new Error("The required trails cannot all be reached through this network. Add a connecting trail or check the endpoints.");
    }
    return best;
  }

  function solve(network) {
    const graph = makeGraph(network);
    if (graph.required.length === 0) return { route: [], total: 0, exact: true };
    graph.edgesById = new Map(network.edges.map((edge, index) => [edge.id, index]));
    return graph.required.length <= EXACT_LIMIT ? runExact(graph) : runHeuristic(graph);
  }

  class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(item) {
      const items = this.items;
      items.push(item);
      let index = items.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (items[parent].distance <= item.distance) break;
        items[index] = items[parent];
        index = parent;
      }
      items[index] = item;
    }
    pop() {
      const items = this.items;
      const first = items[0];
      const last = items.pop();
      if (items.length) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < items.length && items[left].distance < (smallest === index ? last.distance : items[smallest].distance)) smallest = left;
          if (right < items.length && items[right].distance < (smallest === index ? last.distance : items[smallest].distance)) smallest = right;
          if (smallest === index) break;
          items[index] = items[smallest];
          index = smallest;
        }
        items[index] = last;
      }
      return first;
    }
  }

  const api = { solve, exactLimit: EXACT_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TrailSolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
