// The desktop is exclusive only while input or recovery owns it. An untouched
// paused job holds its chat's FIFO position, not every other conversation.
export function ownsDesktop(state) {
  if (state.recovery || state.state === 'conflict') return true;
  if (state.operation !== 'voice') return state.inputStarted && !state.inputReleased;
  // Confirmed bubbles retain their receipts, but own no draft or recording.
  return state.segments?.some(part => ['record-intent', 'submitted', 'unknown'].includes(part.state)) ?? false;
}

export function selectDelivery(candidates, waiting = new Set(), inputPaused = false) {
  const ordered = candidates.sort((a, b) => a.row.sequence - b.row.sequence);
  if (inputPaused) {
    // Expiring untouched work needs no desktop ownership and must not wait
    // behind another conversation's draft, recording, or unexpired work.
    return (
      ordered.find(({ revoked, state }) => revoked && !ownsDesktop(state) && !state.inputStarted && !state.submitted) ??
      ordered.find(candidate => candidate.revoked || candidate.receiptOnly) ??
      null
    );
  }
  const occupied = ordered.find(({ state }) => ownsDesktop(state));
  if (occupied) return occupied;
  const held = new Set();
  for (const candidate of ordered) {
    const { row, state, revoked } = candidate;
    if (revoked) return candidate; // Retire withdrawn grants even while a chat is paused.
    const chat = JSON.stringify([row.job.accountRef, row.job.kind, row.job.target]);
    if (waiting.has(row.job.id) || candidate.holdReason || row.paused || state.state === 'paused') held.add(chat);
    else if (!held.has(chat)) return candidate;
  }
  return null;
}
