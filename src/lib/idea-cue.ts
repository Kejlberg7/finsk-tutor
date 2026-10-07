export type IdeaCue = { kind: "idea" | "correction"; content: string; explicit: boolean };

/** Keep automatic notes narrow: ordinary Finnish mistakes are lesson material, not app bugs. */
export function extractIdeaCues(utterance: string): IdeaCue[] {
  const text = utterance.trim();
  const laterNote = text.match(/(?:^|[.!?]\s*)(?:(?:det\s+(?:er\s+)?|endnu\s+en\s+)?note\s+(?:til\s+)?senere)(?:\s+er)?\s*(?:at\s*)?[:,.-]?\s*(.+)$/i);
  if (laterNote) {
    const content = laterNote[1].trim().replace(/^[\s.,!?;:-]+/, "").slice(0, 1_500);
    if (content.length >= 5) return [{ kind: "correction", content, explicit: true }];
  }

  const explicit = text.match(
    /(?:^|[.!?]\s*)(?:kan du\s+|vil du\s+)?(?:not[eé]r|gem|husk)(?:\s+lige)?\s+(?:en\s+|et\s+)?(id[eé]|rettelse|fejl|bug|feature|funktion|ændring)(?:\s+til\s+appen)?\s*[:,-]?\s+(.+)$/i,
  );
  if (explicit) {
    const content = explicit[2].trim().slice(0, 1_500);
    return content.length < 5 ? [] : [{
      kind: /^(rettelse|fejl|bug|ændring)$/i.test(explicit[1]) ? "correction" : "idea",
      content,
      explicit: true,
    }];
  }

  const notes: IdeaCue[] = [];
  if (/(?:gemmer|gemning|status|checkpoint)/i.test(text)
    && /(?:afbryd|stopper|starte?\s+(?:samtalen\s+)?igen|trykke?\s+(?:på\s+)?knappen)/i.test(text)) {
    notes.push({ kind: "correction", content: "Samtalen afbrydes under løbende gemning, så jeg må starte den igen. Den skal fortsætte håndfrit.", explicit: false });
  }
  if (/(?:gemmer|gemning|starter?\s+(?:samtalen\s+)?igen|fortsætter)/i.test(text)
    && /(?:forfra|glemmer|ikke\s+(?:rigtig\s+)?ved|mister\s+(?:kontekst|tråden))/i.test(text)) {
    notes.push({ kind: "correction", content: "Efter gemning eller genstart mister tutoren tråden og gentager øvelser fra starten.", explicit: false });
  }
  if (/(?:kører\s+(?:lidt\s+|meget\s+)?(?:i\s+ring|rundt\s+i\s+det\s+samme)|gentager?\s+(?:det\s+samme|de\s+samme\s+ting))/i.test(text)) {
    notes.push({ kind: "correction", content: "Tutoren kører i ring og bør gå videre til nyt stof, når det kendte er øvet.", explicit: false });
  }
  if (/(?:ikke\s+(?:rigtig\s+)?et\s+hint|gav\s+(?:mig\s+)?(?:hele\s+)?svaret\s+som\s+hint)/i.test(text)) {
    notes.push({ kind: "correction", content: "Tutoren giver nogle gange hele svaret som et hint, så øvelsen ikke tester, hvad jeg husker.", explicit: false });
  }
  if (/(?:blive\s+ved\s+med\s+at\s+sige\s+)?(?:fortsæt|fortsætte)/i.test(text)
    && /(?:det\s+er\s+du|ikke\s+mig|ikke\s+jeg|selv\s+fortsætte|hele\s+tiden)/i.test(text)
    && /(?:note|samtale|snakke|sige)/i.test(text)) {
    notes.push({ kind: "correction", content: "Hold samtalen naturligt i gang i cirka 20 minutter. Tutoren skal selv fortsætte til næste øvelse uden at jeg gentagne gange skal sige ‘fortsæt’. En note til senere må ikke misforstås som et ønske om at stoppe.", explicit: false });
  }
  if (/(?:oversætte|oversættelse|forstå|hvad\s+det\s+(?:betyder|bliver\s+sagt))/i.test(text)
    && /finsk/i.test(text) && /dansk/i.test(text)) {
    notes.push({ kind: "idea", content: "Træn begge retninger: Jeg skal både formulere ting på finsk og oversætte det, tutoren siger på finsk, til dansk, så øvelsen tester min forståelse.", explicit: false });
  }
  return notes;
}

export function extractIdeaCue(utterance: string): IdeaCue | null {
  return extractIdeaCues(utterance)[0] ?? null;
}
