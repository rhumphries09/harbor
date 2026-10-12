import { useSyncExternalStore } from 'react';
import { createSidebarStore } from '../../shared/sidebar-sync.js';

// One preload crossing for the entire desktop. Orch requests its own pages.
let store;
export function sidebarStore() {
  if (!store) store = createSidebarStore(window.harbor.sidebar);
  return store;
}
export function useSidebarState() {
  const shared = sidebarStore();
  return useSyncExternalStore(shared.subscribe, shared.getSnapshot);
}
