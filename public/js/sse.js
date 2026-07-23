/* Live updates over Server-Sent Events. The top consumer of the graph: it
 * imports from every feature module and is imported only by the entry, which
 * calls connectSSE() once the page has booted.
 *
 * Every task/deleted event used to trigger render() + renderAttn() +
 * loadManager() unconditionally (~4 wasted full manager fetches/min with a few
 * running cards). Now the task tail is rAF-coalesced (N events in one frame =
 * one render pass), loadManager only fires while the manager tab is visible
 * (hidden → a >=5s debounced badge-only refresh; the visibilitychange and
 * SSE-reopen refetches below cover catch-up), and renderAttn() is chip-only
 * while its popup is hidden. */

import { state, RUNNING_LIKE, optimistic, mergeTaskPayload } from './state.js';
import { $, createCoalescer } from './util.js';
import { applyCooldown, applyModelBlocks, renderNetChip, setServerOffline } from './chips.js';
import { renderErrChip, loadErrors, loadManager, setMgrBusy, renderAttn, refreshMgrBadgeSoon } from './manager.js';
import { render, loadTasks } from './board.js';
import { renderDrawerMeta, renderDrawerActions, closeDrawer, appendTranscriptEntry } from './drawer.js';

const managerVisible = () => !$('#managerView').classList.contains('hidden');

export function connectSSE() {
  const es = new EventSource('/api/events');
  // EventSource reconnects on its own; surface the gap so a stale board is
  // visibly stale, and refetch on recovery to close it.
  let sseWasDown = false;
  es.addEventListener('error', () => {
    sseWasDown = true;
    $('#sseChip').classList.remove('hidden');
  });
  es.addEventListener('open', () => {
    $('#sseChip').classList.add('hidden');
    if (sseWasDown) {
      sseWasDown = false;
      loadTasks();
      if (managerVisible()) loadManager();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadTasks();
      if (managerVisible()) loadManager();
    }
  });

  // One flush per frame no matter how many task/deleted events landed.
  let boardDirty = false;
  let drawerDirty = false;
  const flush = () => {
    if (boardDirty) {
      boardDirty = false;
      render();
      renderAttn(); // chip-only while the popup is hidden
      if (managerVisible()) loadManager();
      else refreshMgrBadgeSoon(); // badge count only, debounced >=5s
    }
    if (drawerDirty) {
      drawerDirty = false;
      const t = state.tasks.find((x) => x.id === state.drawerId);
      if (t) {
        renderDrawerMeta(t); // internally change-gated
        renderDrawerActions(t);
        $('#followForm').classList.toggle('hidden', !!RUNNING_LIKE[t.status] || !t.sessionId);
        $('#promptEdit').disabled = !!RUNNING_LIKE[t.status];
      }
    }
  };
  const scheduleFlush = createCoalescer(flush);

  es.onmessage = (msg) => {
    const evt = JSON.parse(msg.data);
    if (evt.type === 'cooldown') {
      applyCooldown(evt.until);
      return;
    }
    if (evt.type === 'offline') {
      setServerOffline(!!evt.offline);
      renderNetChip();
      return;
    }
    if (evt.type === 'modelblocks') {
      applyModelBlocks(evt.blocks);
      return;
    }
    if (evt.type === 'errors') {
      renderErrChip(evt.open || 0);
      if (!$('#errorsBackdrop').classList.contains('hidden')) loadErrors();
      return;
    }
    if (evt.type === 'manager') {
      if (evt.event === 'busy' && state.mgrState) {
        state.mgrState.busy = evt.busy;
        setMgrBusy(evt.busy);
        if (!evt.busy) {
          if (managerVisible()) loadManager();
          else refreshMgrBadgeSoon();
        }
      } else if (managerVisible()) {
        loadManager();
      } else {
        // keep the badge count fresh on the board tab without a full fetch
        // per event — refreshMgrBadgeSoon debounces to one fetch per >=5s
        refreshMgrBadgeSoon();
      }
      return;
    }
    if (evt.type === 'task') {
      // Stale-echo drop: an event stamped at/below the pre-mutation revision
      // would clobber newer optimistic local state. No v → no version support
      // → apply as before (eventual consistency).
      if (optimistic.isStaleEcho(evt.task.id, evt.task.v)) return;
      const i = state.tasks.findIndex((t) => t.id === evt.task.id);
      if (i >= 0) state.tasks[i] = mergeTaskPayload(state.tasks[i], evt.task);
      else state.tasks.unshift(evt.task);
      if (evt.task.v !== undefined) {
        state.boardV = Math.max(state.boardV || 0, evt.task.v);
        optimistic.clear(evt.task.id); // server is ahead of the optimistic base
      }
      boardDirty = true;
      if (state.drawerId === evt.task.id) drawerDirty = true;
      scheduleFlush();
      return;
    }
    if (evt.type === 'deleted') {
      optimistic.clear(evt.taskId);
      state.tasks = state.tasks.filter((t) => t.id !== evt.taskId);
      if (state.drawerId === evt.taskId) closeDrawer(true);
      boardDirty = true;
      scheduleFlush();
      return;
    }
    if (evt.type === 'output' && state.drawerId === evt.taskId) {
      appendTranscriptEntry(evt.entry); // rAF-batched inside drawer.js
    }
  };
}
