// Which branch the viewport and review panel show ("main" or a proposal id).
// Pure so it can be tested without a browser.

/** On a new state from the daemon: follow the branch Claude is editing only when that changes,
 *  so a thumbnail the human clicked stays shown across later state updates. */
export function focusOnState(focus: string, prevActive: string | undefined, active: string): string {
  return active !== prevActive && active !== 'main' ? active : focus;
}

/** On render: if the shown proposal was committed or discarded, fall back to an open one or main. */
export function validFocus(focus: string, openIds: string[]): string {
  return focus !== 'main' && !openIds.includes(focus) ? openIds[0] ?? 'main' : focus;
}
