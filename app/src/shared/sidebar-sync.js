
// Desktop wire protocol. Full snapshots are for boot/recovery; ordinary pushes
// contain only changed rows and project metadata. Ordering travels only when it
// changes. The mobile composition continues to serve full snapshots.
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function createSidebarPublisher() {
  let state = { version: 0, model: { projects: [], liveProjects: [] }, historyCount: 0, indexerSessionCount: 0 };
  let locations = new Map();
  const reindex = () => {
    locations = new Map();
    state.model.projects.forEach((p, pi) => p.sessions.forEach((s, si) => locations.set(s.id, [pi, si])));
  };
  function publish(next) {
    const previous = state;
    const oldProjects = new Map(previous.model.projects.map((p) => [p.label, p]));
    const changes = [];
    const projects = next.model.projects.map((project) => {
      const old = oldProjects.get(project.label);
      const oldRows = new Map((old?.sessions || []).map((s) => [s.id, s]));
      const upsert = [];
      const sessions = project.sessions.map((row) => {
        const before = oldRows.get(row.id);
        oldRows.delete(row.id);
        if (equal(before, row)) return before;
        upsert.push(row);
        return row;
      });
      const { sessions: ignored, ...meta } = project;
      const { sessions: ignoredOld, ...oldMeta } = old || {};
      const order = sessions.map((s) => s.id);
      const reordered = !old || !equal(order, old.sessions.map((s) => s.id));
      if (!upsert.length && !oldRows.size && !reordered && equal(meta, oldMeta)) return old;
      changes.push({ label: project.label, ...(equal(meta, oldMeta) ? {} : { meta }),
        upsert, remove: [...oldRows.keys()], ...(reordered ? { order } : {}) });
      return { ...meta, sessions };
    });
    const order = projects.map((p) => p.label);
    const removed = [...oldProjects.keys()].filter((key) => !order.includes(key));
    const { projects: ignored, ...modelMeta } = next.model;
    const { projects: ignoredOld, ...oldModelMeta } = previous.model;
    const counts = { historyCount: next.historyCount, indexerSessionCount: next.indexerSessionCount };
    if (!changes.length && !removed.length && equal(order, previous.model.projects.map((p) => p.label))
      && equal(modelMeta, oldModelMeta) && equal(counts, { historyCount: previous.historyCount, indexerSessionCount: previous.indexerSessionCount })) return null;
    state = { version: previous.version + 1, model: { ...modelMeta, projects }, ...counts };
    reindex();
    return { kind: 'delta', base: previous.version, version: state.version, projects: changes, remove: removed,
      ...(!equal(order, previous.model.projects.map((p) => p.label)) ? { order } : {}),
      ...(!equal(modelMeta, oldModelMeta) ? { modelMeta } : {}), ...counts };
  }
  function patchRows(patches) {
    const projects = state.model.projects.slice();
    const changed = new Map();
    for (const [id, fields] of patches) {
      const location = locations.get(id);
      if (!location) continue;
      const [pi, si] = location;
      const old = projects[pi].sessions[si];
      if (Object.keys(fields).every((key) => equal(old[key], fields[key]))) continue;
      if (!changed.has(pi)) {
        projects[pi] = { ...projects[pi], sessions: projects[pi].sessions.slice() };
        changed.set(pi, []);
      }
      const row = { ...old, ...fields };
      projects[pi].sessions[si] = row;
      changed.get(pi).push(row);
    }
    if (!changed.size) return null;
    const base = state.version;
    state = { ...state, version: base + 1, model: { ...state.model, projects } };
    return { kind: 'delta', base, version: state.version,
      projects: [...changed].map(([pi, upsert]) => ({ label: projects[pi].label, upsert, remove: [] })), remove: [] };
  }
  return { publish, patchRows, getState: () => state };
}

function applySidebarDelta(state, delta) {
  if (!state || delta?.kind !== 'delta' || delta.base !== state.version || delta.version !== delta.base + 1) return null;
  const projects = new Map(state.model.projects.map((p) => [p.label, p]));
  for (const label of delta.remove || []) projects.delete(label);
  for (const change of delta.projects || []) {
    const old = projects.get(change.label);
    if (!old && !change.meta) return null;
    const rows = new Map((old?.sessions || []).map((s) => [s.id, s]));
    for (const id of change.remove || []) rows.delete(id);
    for (const row of change.upsert || []) rows.set(row.id, row);
    const sessions = change.order ? change.order.map((id) => rows.get(id)) : [...rows.values()];
    if (sessions.some((row) => !row)) return null;
    projects.set(change.label, { ...(change.meta || old), sessions });
  }
  const ordered = delta.order ? delta.order.map((label) => projects.get(label)) : [...projects.values()];
  if (ordered.some((p) => !p)) return null;
  return { version: delta.version, model: { ...state.model, ...delta.modelMeta, projects: ordered },
    historyCount: delta.historyCount ?? state.historyCount,
    indexerSessionCount: delta.indexerSessionCount ?? state.indexerSessionCount };
}

function createSidebarStore(api) {
  let state = { version: -1, model: { projects: [], liveProjects: [] }, loaded: false };
  const listeners = new Set();
  let loading = null;
  let queued = [];
  let unsubscribe = null;
  let pinned = false;
  let retry = null; let closed = false;
  const notify = () => { for (const listener of listeners) listener(); };
  const resync = () => {
    if (loading) return loading;
    clearTimeout(retry); retry = null;
    let failed = false;
    loading = Promise.resolve().then(() => api.getState()).then((fresh) => {
      if (pinned) { queued = []; return; }
      state = { ...fresh, loaded: true };
      const pending = queued;
      queued = [];
      for (const delta of pending) {
        if (delta.version <= state.version) continue;
        if (delta.model) { state = { ...delta, loaded: true }; continue; }
        const next = applySidebarDelta(state, delta);
        if (!next) { queued.push(delta); break; }
        state = { ...next, loaded: true };
      }
      notify();
    }).catch((error) => { failed = true; throw error; }).finally(() => {
      loading = null;
      // A failed IPC or stale recovery snapshot must not create a tight RPC
      // loop. Retry even without another push, so a quiet renderer heals too.
      if (!closed && !pinned && (failed || queued.length)) retry = setTimeout(() => resync().catch(() => {}), 500);
    });
    return loading;
  };
  const receive = (message) => {
    if (pinned) return;
    if (message?.model) {
      if (loading) { queued.push(message); return; }
      if (message.version < state.version) { resync().catch(() => {}); return; }
      state = { ...message, loaded: true }; notify(); return;
    }
    if (loading) { queued.push(message); return; }
    const next = applySidebarDelta(state, message);
    if (!next) { queued.push(message); resync().catch(() => {}); return; }
    state = { ...next, loaded: true };
    notify();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) { unsubscribe = api.onUpdate(receive); resync().catch(() => {}); }
      return () => listeners.delete(listener);
    },
    resync,
    setTestModel(model) {
      pinned = model != null;
      if (pinned) { state = { ...state, model, loaded: true }; notify(); }
      else resync().catch(() => {});
    },
    close() { closed = true; clearTimeout(retry); unsubscribe?.(); unsubscribe = null; listeners.clear(); },
  };
}

export { equal, createSidebarPublisher, applySidebarDelta, createSidebarStore };
