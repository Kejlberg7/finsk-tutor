import assert from "node:assert/strict";
import test from "node:test";
import { extractIdeaCue, extractIdeaCues } from "../src/lib/idea-cue";
import { buildResumeInput, shouldAutoResume } from "../src/lib/session-continuity";
import { cleanFragments, compactTranscript, completedTurnCutoff } from "../src/lib/transcript";
import type { TranscriptLine } from "../src/lib/learning-types";

test("explicit notes and clearly stated app problems are captured", () => {
  assert.deepEqual(extractIdeaCue("Notér idé: Vis mine sidste samtaler"), {
    kind: "idea", content: "Vis mine sidste samtaler", explicit: true,
  });
  assert.deepEqual(extractIdeaCue("Noter en rettelse: Lektionen gentager sig"), {
    kind: "correction", content: "Lektionen gentager sig", explicit: true,
  });
  assert.equal(extractIdeaCues("Når du gemmer status, stopper samtalen og jeg skal starte samtalen igen. Vi kører i ring.").length, 2);
  assert.match(extractIdeaCue("Det var ikke rigtig et hint, du sagde det jeg skulle sige")?.content ?? "", /hint/);
  assert.equal(extractIdeaCue("Gentag det finske ord igen"), null);
  assert.equal(extractIdeaCue("Husk ordet kiitos"), null);
  assert.equal(extractIdeaCue("Jeg sagde töissä, men det skulle være töihin"), null);
});

test("natural note-to-self wording and learning requests are saved without a magic phrase", () => {
  assert.deepEqual(extractIdeaCue("Note til senere. Det er du, og ikke jeg, der skal blive ved med at sige fortsæt. Det bliver nødt til at være rimelig kontinuerligt."), {
    kind: "correction",
    content: "Det er du, og ikke jeg, der skal blive ved med at sige fortsæt. Det bliver nødt til at være rimelig kontinuerligt.",
    explicit: true,
  });
  assert.deepEqual(extractIdeaCue("Jeg tænker også, det er en note til senere, at jeg også skal kunne oversætte fra finsk til dansk, så jeg forstår, hvad der bliver sagt."), {
    kind: "idea",
    content: "Træn begge retninger: Jeg skal både formulere ting på finsk og oversætte det, tutoren siger på finsk, til dansk, så øvelsen tester min forståelse.",
    explicit: false,
  });
});

test("an interrupted lesson resumes with bounded recent history", () => {
  const fragments: TranscriptLine[] = [
    { speaker: "dig", text: "Skal vi videre til noget nyt?" },
    { speaker: "tutor", text: "Yes. Next: opiskelen tänään." },
    { speaker: "dig", text: "Opiskelen tänään." },
  ];
  const input = buildResumeInput(fragments);
  assert.equal(input.length, 4);
  assert.equal(input[0].role, "developer");
  assert.equal(input.at(-1)?.content[0].text, "Opiskelen tänään.");
  assert.equal(buildResumeInput([]).length, 0);
  assert.equal(shouldAutoResume("connection_lost", false), true);
  assert.equal(shouldAutoResume("expired", false), true);
  assert.equal(shouldAutoResume("content", false), false);
  assert.equal(shouldAutoResume("connection_lost", true), false);
});

test("checkpoints only score completed learner-and-tutor exchanges", () => {
  const fragments: TranscriptLine[] = [
    { speaker: "tutor", text: "Say kiitos." },
    { speaker: "dig", text: "Kiitos." },
    { speaker: "tutor", text: "Yes, correct." },
    { speaker: "dig", text: "What next?" },
  ];
  assert.equal(completedTurnCutoff(fragments), 3);
  assert.equal(completedTurnCutoff(fragments.slice(0, 3)), 1);
  assert.equal(completedTurnCutoff(fragments.slice(0, 1)), 0);
});

test("transcript fragments combine without dropping speech", () => {
  const result = compactTranscript([
    { speaker: "dig", text: "Notér " },
    { speaker: "dig", text: "idé: " },
    { speaker: "dig", text: "mere variation." },
    { speaker: "tutor", text: "Okay." },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Notér idé: mere variation.");
});

test("checkpoint cursor input rejects malformed fragments", () => {
  assert.throws(() => cleanFragments([{ speaker: "dig", text: "ok" }, { speaker: "other", text: "bad" }]));
  assert.equal(cleanFragments([{ speaker: "dig", text: "kiitos" }]).length, 1);
});
