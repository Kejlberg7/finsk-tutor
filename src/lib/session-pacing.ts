/** A voice-safe pacing nudge based on time since this practice session began. */
export function sessionPacingUpdate(elapsedSeconds: number): string {
  const elapsedMinutes = Math.max(0, Math.floor(elapsedSeconds / 60));
  if (elapsedMinutes >= 30) {
    return `Elapsed practice time: about ${elapsedMinutes} minutes. The 30-minute target has been reached. Briefly acknowledge that, then ask whether the learner wants to stop or continue; do not end or disconnect on your own. If they continue, start another useful block.`;
  }
  if (elapsedMinutes >= 24) {
    return `Elapsed practice time: about ${elapsedMinutes} minutes. The 30-minute target has not yet been reached. Continue teaching; use connected mixed retrieval and review in these final minutes, and do not say the lesson is finished.`;
  }
  return `Elapsed practice time: about ${elapsedMinutes} minutes. Keep the 30-minute target in mind. Continue directly into the next connected lesson block; do not wrap up or say the lesson is finished.`;
}
