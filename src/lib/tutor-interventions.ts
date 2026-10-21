export function tutorIntervention(text: string, elapsedSeconds: number): { code: string; instruction: string } | null {
  if (/(?:hvordan\s+siger\s+du|det\s+betyder|jeg\s+vil\s+gerne|hvor\s+meget\s+koster|hvor\s+går\s+du|du\s+skal\s+bruge)/i.test(text)) {
    return { code: "coaching_language", instruction: "Speak all coaching and meanings in English. The learner may translate into Danish; you must give production cues in English. Continue the current exercise in English without an extended apology." };
  }
  if (elapsedSeconds < 29 * 60 && /(?:want\s+to\s+(?:keep\s+going|continue|stop)|wanna\s+keep|shall\s+we\s+(?:stop|finish)|we(?:'|’)?ll\s+stop\s+here|we(?:'|’)?re\s+done|the\s+lesson\s+is\s+(?:over|finished))/i.test(text)) {
    return { code: "early_wrap_up", instruction: "The 30-minute practice target has not been reached. If the learner has not asked to stop, immediately continue with the next short exercise. Do not ask them to confirm continuation after each block." };
  }
  if (/\bmenään\b|\bhyvää\s+kysymys\b/i.test(text)) {
    return { code: "finnish_model_form", instruction: "Check that Finnish form with the backend before using it again: menen = I am going; mennään = let's go; 'menään' is not the model form. 'Hyvä kysymys' is the correct expression. Correct the example concisely and continue." };
  }
  return null;
}
