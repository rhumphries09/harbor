import { useSyncExternalStore } from 'react';
import { createDialogStore } from './dialog-state.cjs';

export const dialogStore = createDialogStore();
// Session ids whose window shows a terminal dialog waiting on you.
export function useTerminalDialogs() {
  return useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot);
}
