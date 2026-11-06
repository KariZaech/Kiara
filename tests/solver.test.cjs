const test = require("node:test");
const assert = require("node:assert/strict");
const { solve } = require("../solver.js");

function point(id) {
  return { id, name: id };
}

function trail(id, from, to, forward, reverse, required = true) {
  return { id, name: id, from, to, forward, reverse, required };
}

test("finds the globally fastest route with asymmetric trail times", () => {
  const result = solve({
    nodes: [point("A"), point("B"), point("C")],
    edges: [trail("AB", "A", "B", 4, 3), trail("BC", "B", "C", 5, 6)]
  });
  assert.equal(result.exact, true);
  assert.equal(result.total, 9);
  assert.deepEqual(result.route.map(({ from, to }) => `${from}${to}`), ["AB", "BC"]);
});

test("uses an optional access trail to connect the required sections", () => {
  const result = solve({
    nodes: ["A", "B", "C", "D"].map(point),
    edges: [
      trail("AB", "A", "B", 2, 2),
      trail("BC", "B", "C", 1, 1, false),
      trail("CD", "C", "D", 2, 2)
    ]
  });
  assert.equal(result.total, 5);
  assert.equal(result.route.some((step) => step.edgeId === "BC"), true);
});

test("repeats a trail when that is the fastest way to cover a branch", () => {
  const result = solve({
    nodes: ["O", "A", "B", "C"].map(point),
    edges: [
      trail("OA", "O", "A", 1, 1),
      trail("OB", "O", "B", 1, 1),
      trail("OC", "O", "C", 1, 1)
    ]
  });
  assert.equal(result.total, 4);
  assert.equal(result.route.length, 4);
  assert.equal(new Set(result.route.map((step) => step.edgeId)).size, 3);
});

test("returns a fast heuristic route for networks above the exact limit", () => {
  const nodes = Array.from({ length: 16 }, (_, index) => point(`P${index}`));
  const edges = Array.from({ length: 15 }, (_, index) =>
    trail(`T${index}`, `P${index}`, `P${index + 1}`, 2, 2));
  const result = solve({ nodes, edges });
  assert.equal(result.exact, false);
  assert.equal(result.total, 30);
  assert.equal(new Set(result.route.map((step) => step.edgeId)).size, 15);
});

test("reports required trails that cannot be connected", () => {
  assert.throws(() => solve({
    nodes: ["A", "B", "C", "D"].map(point),
    edges: [trail("AB", "A", "B", 1, 1), trail("CD", "C", "D", 1, 1)]
  }), /cannot all be reached/);
});

test("returns an empty route when there are no required trails", () => {
  const result = solve({ nodes: [point("A"), point("B")], edges: [trail("AB", "A", "B", 1, 1, false)] });
  assert.deepEqual(result, { route: [], total: 0, exact: true });
});
