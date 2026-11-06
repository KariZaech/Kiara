(function () {
  "use strict";

  const DRAFT_KEY = "trailwise.draft.v1";
  const VERSIONS_KEY = "trailwise.versions.v1";
  const DEFAULT_MINUTES = 10;
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    map: $("#network-map"),
    emptyMap: $("#empty-map"),
    rows: $("#trail-rows"),
    emptyTrails: $("#empty-trails"),
    datalist: $("#point-options"),
    versionList: $("#version-list"),
    routePanel: $("#route-panel"),
    routeSteps: $("#route-steps"),
    toast: $("#toast"),
    saveStatus: $("#save-status")
  };

  let network = { nodes: [], edges: [] };
  let routeResult = null;
  let activeDrag = null;
  let toastTimer = 0;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function slug(value) {
    return value.trim().toLocaleLowerCase();
  }

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeNetwork(value) {
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new Error("The file must contain nodes and edges, or nodes and relationships.");
    }
    const nodes = value.nodes.map((node, index) => {
      const name = String(node.name ?? node.caption ?? node.id ?? "").trim();
      if (!name) throw new Error(`Point ${index + 1} needs a name.`);
      const position = node.position || {};
      return {
        id: String(node.id || newId("point")),
        name,
        x: Number.isFinite(Number(node.x ?? position.x)) ? Number(node.x ?? position.x) : null,
        y: Number.isFinite(Number(node.y ?? position.y)) ? Number(node.y ?? position.y) : null
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodesByName = new Map(nodes.map((node) => [slug(node.name), node]));

    const edges = value.edges.map((edge, index) => {
      const fromNode = nodeById.get(String(edge.from ?? edge.fromId ?? ""));
      const toNode = nodeById.get(String(edge.to ?? edge.toId ?? ""));
      const fromName = String(edge.start ?? edge.fromName ?? "");
      const toName = String(edge.end ?? edge.toName ?? "");
      const from = fromNode || nodesByName.get(slug(fromName));
      const to = toNode || nodesByName.get(slug(toName));
      if (!from || !to) throw new Error(`Trail ${index + 1} refers to a point that is not in the file.`);
      if (from.id === to.id) throw new Error(`Trail ${index + 1} must connect two different points.`);
      const properties = edge.properties || {};
      const inheritedTime = Number(properties.weight);
      return {
        id: String(edge.id || newId("trail")),
        name: String(edge.name || `Trail ${index + 1}`),
        from: from.id,
        to: to.id,
        forward: positiveNumber(edge.forward ?? edge.timeForward ?? edge.time ?? (Number.isFinite(inheritedTime) && inheritedTime > 0 ? inheritedTime : DEFAULT_MINUTES)),
        reverse: positiveNumber(edge.reverse ?? edge.timeReverse ?? edge.time ?? (Number.isFinite(inheritedTime) && inheritedTime > 0 ? inheritedTime : DEFAULT_MINUTES)),
        required: edge.required !== false && edge.mustRide !== false
      };
    });
    validateNodes(nodes);
    validateEdges(edges);
    return { nodes, edges };
  }

  function positiveNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error("Trail times must be positive numbers of minutes.");
    return number;
  }

  function validateNodes(nodes) {
    const ids = new Set();
    const names = new Set();
    for (const node of nodes) {
      if (ids.has(node.id)) throw new Error(`Point ID "${node.id}" appears more than once.`);
      if (names.has(slug(node.name))) throw new Error(`Point name "${node.name}" appears more than once.`);
      ids.add(node.id);
      names.add(slug(node.name));
    }
  }

  function validateEdges(edges) {
    const ids = new Set();
    for (const edge of edges) {
      if (ids.has(edge.id)) throw new Error(`Trail ID "${edge.id}" appears more than once.`);
      ids.add(edge.id);
    }
  }

  function toSampleNetwork(data) {
    const nodes = data.nodes.map((node) => ({
      id: String(node.id),
      name: String(node.caption || node.id),
      x: Number(node.position?.x),
      y: Number(node.position?.y)
    }));
    const edges = data.relationships.map((edge, index) => {
      const weight = Number(edge.properties?.weight);
      const time = Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_MINUTES;
      return {
        id: String(edge.id || `trail-${index + 1}`),
        name: `Trail ${index + 1}`,
        from: String(edge.fromId),
        to: String(edge.toId),
        forward: time,
        reverse: time,
        required: true
      };
    });
    const sample = normalizeNetwork({ nodes, edges });
    arrangeToTimes(sample, data.relationships);
    return sample;
  }

  function arrangeToTimes(graph, sourceEdges = []) {
    if (!graph.nodes.length || !graph.edges.length) return;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const edgeLengths = graph.edges.map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      return Math.hypot(to.x - from.x, to.y - from.y);
    }).filter((length) => length > 0).sort((a, b) => a - b);
    if (!edgeLengths.length) return;
    const sampleEdgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
    const calibrations = sourceEdges.flatMap((sourceEdge) => {
      const sampleEdge = sampleEdgesById.get(String(sourceEdge.id));
      const weight = Number(sourceEdge.properties?.weight);
      if (!sampleEdge || !Number.isFinite(weight) || weight <= 0) return [];
      const from = nodeById.get(sampleEdge.from);
      const to = nodeById.get(sampleEdge.to);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      return length > 0 ? [length / weight] : [];
    }).sort((a, b) => a - b);
    const medianLength = edgeLengths[Math.floor(edgeLengths.length / 2)];
    const scale = calibrations.length
      ? 1 / calibrations[Math.floor(calibrations.length / 2)]
      : 10 / medianLength;
    for (const node of graph.nodes) {
      node.x *= scale;
      node.y *= scale;
    }
    spreadNodes(graph);
    syncIncidentTimes(graph);
  }

  function spreadNodes(graph) {
    const spacing = 14;
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const shifts = graph.nodes.map(() => ({ x: 0, y: 0 }));
      for (let first = 0; first < graph.nodes.length; first += 1) {
        for (let second = first + 1; second < graph.nodes.length; second += 1) {
          const a = graph.nodes[first];
          const b = graph.nodes[second];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= spacing) continue;
          if (distance < 0.001) {
            const angle = (second - first) * Math.PI * (3 - Math.sqrt(5));
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          const correction = ((spacing - distance) * 0.05) / distance / 2;
          shifts[first].x -= dx * correction;
          shifts[first].y -= dy * correction;
          shifts[second].x += dx * correction;
          shifts[second].y += dy * correction;
        }
      }
      graph.nodes.forEach((node, index) => {
        node.x += shifts[index].x;
        node.y += shifts[index].y;
      });
    }
  }

  function syncIncidentTimes(graph, nodeId) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      if (nodeId && edge.from !== nodeId && edge.to !== nodeId) continue;
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      edge.forward = Math.max(0.1, Math.hypot(to.x - from.x, to.y - from.y));
    }
  }

  function persistDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(network));
      elements.saveStatus.textContent = "Draft saved locally";
    } catch (error) {
      elements.saveStatus.textContent = "Could not save draft";
      showToast(`Could not save your draft: ${error.message}`, true);
    }
  }

  function getVersions() {
    try {
      const parsed = JSON.parse(localStorage.getItem(VERSIONS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      showToast(`Saved versions could not be read: ${error.message}`, true);
      return [];
    }
  }

  function setNetwork(value, message) {
    network = normalizeNetwork(value);
    placeUnpositionedNodes(network);
    routeResult = null;
    persistDraft();
    render();
    if (message) showToast(message);
  }

  function placeUnpositionedNodes(graph) {
    const placed = new Set(graph.nodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y)).map((node) => node.id));
    if (!graph.nodes.length) return;
    if (!placed.size) {
      const first = graph.nodes[0];
      first.x = 0;
      first.y = 0;
      placed.add(first.id);
    }
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    let pass = 0;
    while (placed.size < graph.nodes.length) {
      let changed = false;
      for (const edge of graph.edges) {
        const from = graph.nodes.find((node) => node.id === edge.from);
        const to = graph.nodes.find((node) => node.id === edge.to);
        if (placed.has(from.id) && !placed.has(to.id)) {
          const angle = pass * goldenAngle;
          to.x = from.x + edge.forward * Math.cos(angle);
          to.y = from.y + edge.forward * Math.sin(angle);
          placed.add(to.id);
          changed = true;
        } else if (placed.has(to.id) && !placed.has(from.id)) {
          const angle = pass * goldenAngle;
          from.x = to.x - edge.forward * Math.cos(angle);
          from.y = to.y - edge.forward * Math.sin(angle);
          placed.add(from.id);
          changed = true;
        }
        pass += 1;
      }
      if (!changed && placed.size < graph.nodes.length) {
        const node = graph.nodes.find((item) => !placed.has(item.id));
        const angle = pass * goldenAngle;
        node.x = graph.nodes[0].x + 10 * Math.cos(angle);
        node.y = graph.nodes[0].y + 10 * Math.sin(angle);
        placed.add(node.id);
      }
    }
    syncIncidentTimes(graph);
  }

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.classList.add("visible");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3400);
  }

  function pointName(id) {
    return network.nodes.find((node) => node.id === id)?.name || "Unknown point";
  }

  function render() {
    renderSummary();
    renderPoints();
    renderTable();
    renderVersions();
    renderMap();
    renderRoute();
  }

  function renderSummary() {
    $("#trail-count").textContent = network.edges.filter((edge) => edge.required).length;
    $("#point-count").textContent = network.nodes.length;
    $("#optional-count").textContent = network.edges.filter((edge) => !edge.required).length;
    $("#table-count").textContent = network.edges.length;
  }

  function renderPoints() {
    elements.datalist.innerHTML = network.nodes
      .map((node) => `<option value="${escapeHtml(node.name)}"></option>`)
      .join("");
  }

  function renderTable() {
    elements.emptyTrails.hidden = network.edges.length > 0;
    elements.rows.innerHTML = network.edges.map((edge) => `
      <tr data-id="${escapeHtml(edge.id)}">
        <td><div class="trail-endpoints">
          <input type="text" data-field="from" list="point-options" value="${escapeHtml(pointName(edge.from))}" aria-label="Start point">
          <span>to</span>
          <input type="text" data-field="to" list="point-options" value="${escapeHtml(pointName(edge.to))}" aria-label="End point">
        </div></td>
        <td><div class="inline-times">
          <input type="number" min="0.1" max="100000" step="0.1" data-field="forward" value="${escapeHtml(edge.forward)}" aria-label="Minutes going">
          <span>/</span>
          <input type="number" min="0.1" max="100000" step="0.1" data-field="reverse" value="${escapeHtml(edge.reverse)}" aria-label="Minutes returning">
        </div></td>
        <td><label class="required-toggle"><input type="checkbox" data-field="required" ${edge.required ? "checked" : ""}> Must ride</label></td>
        <td><button class="remove-trail" type="button" data-action="remove" aria-label="Remove trail">×</button></td>
      </tr>
    `).join("");
  }

  function renderVersions() {
    const versions = getVersions();
    elements.versionList.innerHTML = versions.length ? versions.map((version) => `
      <div class="version-row" data-id="${escapeHtml(version.id)}">
        <div class="version-main">
          <span class="version-name">${escapeHtml(version.name)}</span>
          <span class="version-meta">${version.network.edges.length} trails · ${escapeHtml(new Date(version.savedAt).toLocaleDateString())}</span>
        </div>
        <div class="version-actions">
          <button type="button" class="mini-button" data-action="load">Open</button>
          <button type="button" class="mini-button delete" data-action="delete" aria-label="Delete version">×</button>
        </div>
      </div>
    `).join("") : '<div class="no-versions">Your saved networks will show up here.</div>';
  }

  function getLayout() {
    const width = Math.max(elements.map.clientWidth, 300);
    const height = Math.max(elements.map.clientHeight, 280);
    const points = network.nodes;
    if (!points.length) return { width, height, positions: new Map() };
    const coords = points.map((node) => [node.x, node.y]);
    const xs = coords.map(([x]) => x);
    const ys = coords.map(([, y]) => y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const padding = 44;
    const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 1), (height - padding * 2) / Math.max(maxY - minY, 1));
    const drawnWidth = (maxX - minX) * scale;
    const drawnHeight = (maxY - minY) * scale;
    const offsetX = (width - drawnWidth) / 2;
    const offsetY = (height - drawnHeight) / 2;
    return {
      width, height,
      scale, offsetX, offsetY, minX, minY,
      positions: new Map(points.map((node, index) => [
        node.id,
        { x: offsetX + (coords[index][0] - minX) * scale, y: offsetY + (coords[index][1] - minY) * scale }
      ]))
    };
  }

  function renderMap() {
    const layout = activeDrag?.layout || getLayout();
    const { width, height } = layout;
    const positions = activeDrag
      ? new Map(network.nodes.map((node) => [node.id, {
        x: layout.offsetX + (node.x - layout.minX) * layout.scale,
        y: layout.offsetY + (node.y - layout.minY) * layout.scale
      }]))
      : layout.positions;
    elements.map.setAttribute("viewBox", `0 0 ${width} ${height}`);
    $("#empty-map").hidden = network.nodes.length > 0;
    if (!network.nodes.length) {
      elements.map.innerHTML = "";
      return;
    }
    const plannedIds = new Set(routeResult?.route.map((step) => step.edgeId) || []);
    const routeStart = routeResult?.route[0]?.from;
    const edgeMarkup = network.edges.map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return "";
      const title = `${pointName(edge.from)} to ${pointName(edge.to)}: ${formatTime(edge.forward)} min out, ${formatTime(edge.reverse)} min back`;
      const optional = edge.required ? "" : " optional";
      const planned = plannedIds.has(edge.id) ? " planned" : "";
      return `<g><title>${escapeHtml(title)}</title><line class="map-edge${optional}${planned}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" marker-end="url(#out-arrow)"></line></g>`;
    }).join("");
    const nodeMarkup = network.nodes.map((node) => {
      const point = positions.get(node.id);
      const startClass = routeStart === node.id ? " start-node" : "";
      return `<g class="map-node" data-node-id="${escapeHtml(node.id)}" tabindex="0" role="button" aria-label="Drag ${escapeHtml(node.name)} point">
        <circle class="node-hit-area" cx="${point.x}" cy="${point.y}" r="14"></circle>
        <circle class="node-circle${startClass}" cx="${point.x}" cy="${point.y}" r="6"></circle>
        <text class="node-text" x="${point.x}" y="${point.y + 10}">${escapeHtml(node.name)}</text></g>`;
    }).join("");
    elements.map.innerHTML = `<defs><marker id="out-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa99f"></path></marker></defs><g>${edgeMarkup}${nodeMarkup}</g>`;
  }

  function toMapPoint(event) {
    const rect = elements.map.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) * (activeDrag?.layout.width || rect.width) / rect.width,
      y: (event.clientY - rect.top) * (activeDrag?.layout.height || rect.height) / rect.height
    };
  }

  function moveNode(nodeId, x, y) {
    const node = network.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    node.x = x;
    node.y = y;
    syncIncidentTimes(network, nodeId);
    routeResult = null;
  }

  elements.map.addEventListener("pointerdown", (event) => {
    const nodeElement = event.target.closest("[data-node-id]");
    if (!nodeElement || event.button !== 0) return;
    const point = toMapPoint(event);
    if (!point) return;
    event.preventDefault();
    activeDrag = {
      nodeId: nodeElement.dataset.nodeId,
      pointerId: event.pointerId,
      layout: getLayout()
    };
    elements.map.classList.add("dragging");
    elements.map.setPointerCapture(event.pointerId);
  });

  elements.map.addEventListener("pointermove", (event) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    const point = toMapPoint(event);
    if (!point) return;
    const { layout, nodeId } = activeDrag;
    moveNode(
      nodeId,
      (point.x - layout.offsetX) / layout.scale + layout.minX,
      (point.y - layout.offsetY) / layout.scale + layout.minY
    );
    renderMap();
  });

  elements.map.addEventListener("pointerup", (event) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    if (elements.map.hasPointerCapture(event.pointerId)) elements.map.releasePointerCapture(event.pointerId);
    activeDrag = null;
    elements.map.classList.remove("dragging");
    persistDraft();
    render();
  });

  elements.map.addEventListener("pointercancel", (event) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    activeDrag = null;
    elements.map.classList.remove("dragging");
    persistDraft();
    render();
  });

  elements.map.addEventListener("keydown", (event) => {
    const nodeElement = event.target.closest("[data-node-id]");
    const increments = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const increment = increments[event.key];
    if (!nodeElement || !increment) return;
    event.preventDefault();
    const nodeId = nodeElement.dataset.nodeId;
    const node = network.nodes.find((item) => item.id === nodeId);
    moveNode(nodeId, node.x + increment[0], node.y + increment[1]);
    persistDraft();
    render();
    elements.map.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`)?.focus();
  });

  function formatTime(minutes) {
    return Number(minutes) % 1 === 0 ? String(minutes) : Number(minutes).toFixed(1);
  }

  function formatDuration(minutes) {
    const rounded = Math.round(minutes * 10) / 10;
    const hours = Math.floor(rounded / 60);
    const remainder = Math.round((rounded - hours * 60) * 10) / 10;
    if (hours === 0) return `${formatTime(remainder)} min`;
    return remainder ? `${hours} hr ${formatTime(remainder)} min` : `${hours} hr`;
  }

  function renderRoute() {
    elements.routePanel.hidden = !routeResult;
    $("#reset-route").hidden = !routeResult;
    if (!routeResult) return;
    $("#route-title").textContent = routeResult.exact ? "Fastest route" : "Fast route";
    $("#route-duration").textContent = formatDuration(routeResult.total);
    $("#route-method").textContent = routeResult.exact
      ? "Optimal for this network: every required trail is covered in the lowest possible total ride time."
      : `Best route found with a fast routing heuristic. For over ${TrailSolver.exactLimit} required trails, a global optimum is not guaranteed.`;
    const uniqueTrails = new Set(routeResult.route.filter((step) => network.edges.find((edge) => edge.id === step.edgeId)?.required).map((step) => step.edgeId)).size;
    const repeats = routeResult.route.length - uniqueTrails;
    $("#route-stats").innerHTML = [
      `<span class="route-chip">${uniqueTrails} required trails covered</span>`,
      `<span class="route-chip">${routeResult.route.length} total trail segments</span>`,
      `<span class="route-chip">${repeats} repeat / connector rides</span>`
    ].join("");
    $("#route-step-count").textContent = `(${routeResult.route.length} segments)`;
    elements.routeSteps.innerHTML = routeResult.route.map((step, index) => {
      const trail = network.edges.find((edge) => edge.id === step.edgeId);
      const optional = trail && !trail.required ? " · connector" : "";
      return `<li><strong>${escapeHtml(pointName(step.from))} → ${escapeHtml(pointName(step.to))}</strong> · ${formatDuration(step.time)}${optional}</li>`;
    }).join("");
  }

  function ensurePoint(name, position) {
    const cleaned = name.trim();
    if (!cleaned) throw new Error("Enter a name for each trail point.");
    const existing = network.nodes.find((node) => slug(node.name) === slug(cleaned));
    if (existing) return existing;
    const point = {
      id: newId("point"),
      name: cleaned,
      x: position?.x ?? 0,
      y: position?.y ?? 0
    };
    network.nodes.push(point);
    return point;
  }

  function resizeTrail(trail, distance) {
    const from = network.nodes.find((node) => node.id === trail.from);
    const to = network.nodes.find((node) => node.id === trail.to);
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let currentDistance = Math.hypot(dx, dy);
    if (currentDistance < 0.001) {
      const angle = network.edges.indexOf(trail) * Math.PI * (3 - Math.sqrt(5));
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      currentDistance = 1;
    }
    to.x = from.x + (dx / currentDistance) * distance;
    to.y = from.y + (dy / currentDistance) * distance;
    syncIncidentTimes(network, to.id);
  }

  function updateTrail(trail, field, value) {
    if (field === "required") {
      trail.required = Boolean(value);
    } else if (field === "from" || field === "to") {
      const other = network.nodes.find((node) => node.id === (field === "from" ? trail.to : trail.from));
      const point = ensurePoint(String(value), { x: other.x + 1, y: other.y + 1 });
      if (point.id === other.id) throw new Error("A trail must connect two different points.");
      trail[field] = point.id;
      syncIncidentTimes(network, point.id);
    } else {
      const time = positiveNumber(value);
      if (field === "forward") resizeTrail(trail, time);
      else trail[field] = time;
    }
    if (trail.from === trail.to) throw new Error("A trail must connect two different points.");
    routeResult = null;
    persistDraft();
    render();
  }

  $("#add-trail-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const fromName = String(form.get("from") || "").trim();
      const toName = String(form.get("to") || "").trim();
      if (!fromName || !toName) throw new Error("Enter a name for each trail point.");
      if (slug(fromName) === slug(toName)) throw new Error("A trail must connect two different points.");
      const forward = positiveNumber(form.get("forward"));
      const fromExisting = network.nodes.find((node) => slug(node.name) === slug(fromName));
      const toExisting = network.nodes.find((node) => slug(node.name) === slug(toName));
      const base = network.nodes[0] || { x: 0, y: 0 };
      const angle = network.edges.length * Math.PI * (3 - Math.sqrt(5));
      let fromPosition = null;
      let toPosition = null;
      if (!fromExisting && !toExisting) {
        fromPosition = { x: base.x + 12 * Math.cos(angle), y: base.y + 12 * Math.sin(angle) };
        toPosition = { x: fromPosition.x + forward, y: fromPosition.y };
      } else if (fromExisting && !toExisting) {
        toPosition = { x: fromExisting.x + forward * Math.cos(angle), y: fromExisting.y + forward * Math.sin(angle) };
      } else if (!fromExisting && toExisting) {
        fromPosition = { x: toExisting.x - forward * Math.cos(angle), y: toExisting.y - forward * Math.sin(angle) };
      }
      const from = ensurePoint(fromName, fromPosition);
      const to = ensurePoint(toName, toPosition);
      if (from.id === to.id) throw new Error("A trail must connect two different points.");
      const trail = {
        id: newId("trail"),
        name: `${from.name} – ${to.name}`,
        from: from.id,
        to: to.id,
        forward,
        reverse: positiveNumber(form.get("reverse")),
        required: form.get("required") === "on"
      };
      network.edges.push(trail);
      if (fromExisting && toExisting) resizeTrail(trail, forward);
      routeResult = null;
      persistDraft();
      event.currentTarget.reset();
      event.currentTarget.elements.forward.value = DEFAULT_MINUTES;
      event.currentTarget.elements.reverse.value = DEFAULT_MINUTES;
      event.currentTarget.elements.required.checked = true;
      render();
      showToast("Trail added to your network.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.rows.addEventListener("change", (event) => {
    const field = event.target.dataset.field;
    const row = event.target.closest("tr");
    if (!field || !row) return;
    const trail = network.edges.find((edge) => edge.id === row.dataset.id);
    if (!trail) return;
    try {
      updateTrail(trail, field, field === "required" ? event.target.checked : event.target.value);
    } catch (error) {
      showToast(error.message, true);
      render();
    }
  });

  elements.rows.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='remove']");
    if (!button) return;
    const row = button.closest("tr");
    network.edges = network.edges.filter((edge) => edge.id !== row.dataset.id);
    routeResult = null;
    persistDraft();
    render();
  });

  $("#find-route").addEventListener("click", () => {
    try {
      routeResult = TrailSolver.solve(network);
      render();
      if (routeResult.exact) showToast("Optimal route found.");
      else showToast("Fast route found. The global optimum is not guaranteed for this network.");
    } catch (error) {
      routeResult = null;
      render();
      showToast(error.message, true);
    }
  });

  $("#reset-route").addEventListener("click", () => {
    routeResult = null;
    render();
  });

  $("#save-version").addEventListener("click", () => {
    const name = $("#version-name").value.trim();
    if (!name) {
      showToast("Give this network a name before saving.", true);
      $("#version-name").focus();
      return;
    }
    const versions = getVersions();
    versions.unshift({ id: newId("version"), name, savedAt: new Date().toISOString(), network: structuredClone(network) });
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions));
      $("#version-name").value = "";
      renderVersions();
      showToast(`“${name}” saved.`);
    } catch (error) {
      showToast(`Could not save this version: ${error.message}`, true);
    }
  });

  elements.versionList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const row = button.closest(".version-row");
    const versions = getVersions();
    const version = versions.find((item) => item.id === row.dataset.id);
    if (!version) return;
    if (button.dataset.action === "load") {
      try {
        setNetwork(version.network, `Loaded “${version.name}”.`);
      } catch (error) {
        showToast(`This saved version could not be loaded: ${error.message}`, true);
      }
    } else if (button.dataset.action === "delete") {
      const remaining = versions.filter((item) => item.id !== version.id);
      try {
        localStorage.setItem(VERSIONS_KEY, JSON.stringify(remaining));
        renderVersions();
        showToast(`“${version.name}” deleted.`);
      } catch (error) {
        showToast(`Could not delete this version: ${error.message}`, true);
      }
    }
  });

  $("#clear-network").addEventListener("click", () => {
    if (!network.edges.length && !network.nodes.length) return;
    if (!window.confirm("Clear every trail and point from this network?")) return;
    setNetwork({ nodes: [], edges: [] }, "Network cleared.");
  });

  $("#import-button").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = parsed.relationships ? toSampleNetwork(parsed) : normalizeNetwork(parsed);
      setNetwork(imported, `Imported ${imported.edges.length} trails.`);
    } catch (error) {
      showToast(`Could not import file: ${error.message}`, true);
    } finally {
      event.target.value = "";
    }
  });

  $("#export-button").addEventListener("click", () => {
    const file = new Blob([JSON.stringify(network, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = "trail-network.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    showToast("Network exported as JSON.");
  });

  window.addEventListener("resize", renderMap);

  async function initialize() {
    try {
      const savedDraft = localStorage.getItem(DRAFT_KEY);
      if (savedDraft) {
        setNetwork(JSON.parse(savedDraft));
        return;
      }
    } catch (error) {
      showToast(`The local draft could not be loaded: ${error.message}`, true);
    }

    try {
      const response = await fetch("graphdata.json");
      if (!response.ok) throw new Error(`Request failed (${response.status}).`);
      setNetwork(toSampleNetwork(await response.json()));
      showToast("Sample network loaded. Trails without times start at 10 min in each direction.");
    } catch {
      render();
      elements.saveStatus.textContent = "Import a graph or add trails";
    }
  }

  render();
  initialize();
})();
