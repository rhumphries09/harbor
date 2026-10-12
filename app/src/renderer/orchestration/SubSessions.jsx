import React, { useEffect, useState } from 'react';
import { providerIdentity } from '../providers.js';

function age(ms) {
  if (!ms) return 'age unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function SubSessions({ onOpenSession }) {
  const [query, setQuery] = useState('');
  const [older, setOlder] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true; let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await window.harbor.orchestration.listSubSessions({ query, older, offset, limit: 100 });
        if (active) { setPage(next); setError(null); }
      } catch (reason) { if (active) setError(reason.message); }
      finally { busy = false; }
    };
    const debounce = setTimeout(load, 180);
    const poll = setInterval(load, 30000);
    return () => { active = false; clearTimeout(debounce); clearInterval(poll); };
  }, [query, older, offset]);
  return <section className="sub-sessions" aria-label="Sub-sessions">
    <div className="sub-sessions-head"><div><h3>Sub-sessions</h3><p>Agent runs and approval reviews. Open a conversation to inspect it.</p></div>
      <label><input type="checkbox" checked={older} onChange={(event) => { setOlder(event.target.checked); setOffset(0); }} /> Include older than 7 days</label></div>
    <input className="sub-session-search" type="search" placeholder="Search sub-sessions" aria-label="Search sub-sessions" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} />
    {error ? <p role="alert">{error}</p> : null}
    {!page ? <p>Loading sub-sessions...</p> : null}
    {page?.total === 0 ? <p>No sub-sessions match this view.</p> : null}
    {[true, false].map((linked) => {
      const groups = page?.groups.filter((group) => group.linked === linked) || [];
      if (!groups.length) return null;
      return <div key={String(linked)}><h4>{linked ? 'By parent session' : 'Without a known parent'}</h4>
        {groups.map((group) => <article className="sub-session-group" key={group.key}>
          <h5>{group.parentId ? <button type="button" onClick={() => onOpenSession(group.parentId)}>{group.label}</button> : group.label}</h5>
          {group.sessions.map((row) => <button type="button" className="sub-session-row" key={row.id} data-sub-session-id={row.id} onClick={() => onOpenSession(row.id)}>
            <img src={providerIdentity(row.provider).logo} alt={row.provider} />
            <span className="sub-session-copy"><strong>{row.title || 'Untitled run'}</strong><span>{row.kind} · {row.project}</span></span>
            <span className="sub-session-status">{row.status}<span>{age(row.lastActiveMs)}</span></span>
          </button>)}
        </article>)}
      </div>;
    })}
    {page?.total ? <div className="sub-session-pages"><span>{offset + 1} to {Math.min(offset + 100, page.total)} of {page.total}</span>
      <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
      <button type="button" disabled={page.nextOffset == null} onClick={() => setOffset(page.nextOffset)}>Next</button></div> : null}
  </section>;
}
