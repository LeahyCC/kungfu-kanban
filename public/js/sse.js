/* Live updates over Server-Sent Events. The top consumer of the graph: it
 * imports from every feature module and is imported only by the entry, which
 * calls connectSSE() once the page has booted. */

import { state, RUNNING_LIKE } from './state.js';
import { $, nearBottom } from './util.js';
import { applyCooldown, applyModelBlocks, renderNetChip, setServerOffline } from './chips.js';
import { renderErrChip, loadErrors, loadManager, setMgrBusy, renderAttn } from './manager.js';
import { render, loadTasks } from './board.js';
import { renderDrawerMeta, renderDrawerActions, closeDrawer, entryEl } from './drawer.js';

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
      if (!$('#managerView').classList.contains('hidden')) loadManager();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadTasks();
      if (!$('#managerView').classList.contains('hidden')) loadManager();
    }
  });
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
        if (!evt.busy) loadManager();
      } else if (!$('#managerView').classList.contains('hidden')) {
        loadManager();
      } else if (evt.event === 'suggestions') {
        loadManager(); // keep the badge count fresh even on the board tab
      }
      return;
    }
    if (evt.type === 'task') {
      const i = state.tasks.findIndex((t) => t.id === evt.task.id);
      if (i >= 0) state.tasks[i] = evt.task; else state.tasks.unshift(evt.task);
      render();
      renderAttn(); // reflect permission-blocked status now; loadManager() below re-syncs pruned suggestions
      loadManager();
      if (state.drawerId === evt.task.id) {
        renderDrawerMeta(evt.task);
        renderDrawerActions(evt.task);
        $('#followForm').classList.toggle('hidden', !!RUNNING_LIKE[evt.task.status] || !evt.task.sessionId);
        $('#promptEdit').disabled = !!RUNNING_LIKE[evt.task.status];
      }
    } else if (evt.type === 'deleted') {
      state.tasks = state.tasks.filter((t) => t.id !== evt.taskId);
      render();
      renderAttn();
      loadManager();
      if (state.drawerId === evt.taskId) closeDrawer(true);
    } else if (evt.type === 'output' && state.drawerId === evt.taskId) {
      const box = $('#transcript');
      const pinned = nearBottom(box); // don't yank the reader back down mid-scrollback
      box.appendChild(entryEl(evt.entry));
      if (pinned) box.scrollTop = box.scrollHeight;
    }
  };
}
