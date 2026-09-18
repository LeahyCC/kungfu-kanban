// Shadow model routing via TypeSafe's Jev (a classifier API: typed answers,
// no generated text). On a card's first run, Jev scores how hard the card is
// and we record which model that difficulty would pick. Nothing is routed:
// the card still runs on its own model. `npm run jev-report` compares the
// recorded pick against `modelUsed`, cost and outcome, so a real routing
// switch is only ever built on evidence from this board's own cards.
//
// Off unless KFK_TYPESAFE_KEY is in the server's environment. The card's
// title, prompt and acceptance criteria are sent to TypeSafe. Deliberately not
// the SDK's TYPESAFE_API_KEY: someone with that set for other projects must
// not have their cards shipped to a third party without opting in here.
const { save } = require('./store');

const API = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 5_000;
// Jev takes ~32k tokens of state per question; 20k chars stays well under.
const MAX_PROMPT_CHARS = 20_000;

const DIFFICULTY = {
  type: 'score',
  instructions:
    'How much engineering skill does it take to do the coding task in `card` well? ' +
    'Judge the work the task asks for, not how long its description is.',
  criteria: [
    'Small mechanical change: a typo, copy tweak, config value, rename, version bump, or one obvious fix in one place.',
    'Ordinary feature or bug fix: a few files, clear requirements, follows patterns already in the codebase.',
    'Hard work: unclear requirements, design decisions, many files or systems, tricky debugging, data migrations, or security-sensitive changes.',
  ],
};

// Policy lives here, not in the model: Jev only rates difficulty (0..2) and
// the board decides what that costs. Fable is never suggested; a human or the
// Sensei can still pick it explicitly.
function pickModel(score) {
  if (score < 0.67) return 'haiku';
  if (score < 1.5) return 'sonnet';
  return 'opus';
}

function buildRequest(task) {
  return {
    model: 'jev-latest',
    state: {
      card: {
        title: task.title || '',
        prompt: (task.prompt || '').slice(0, MAX_PROMPT_CHARS),
        acceptanceCriteria: task.acceptanceCriteria || '',
      },
    },
    questions: { difficulty: DIFFICULTY },
  };
}

// Fire-and-forget from the runner: never throws, never delays a launch, and
// asks once per card (re-runs keep the first pick so the report compares
// like with like). Returns the promise so tests can await it.
async function shadowRoute(task) {
  const key = (process.env.KFK_TYPESAFE_KEY || '').trim();
  if (!key || !task || task.jevRoute) return;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildRequest(task)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = (await res.json())?.answers?.difficulty;
    if (typeof answer?.score !== 'number') throw new Error('no difficulty score in response');
    task.jevRoute = {
      pick: pickModel(answer.score),
      score: answer.score,
      confidence: answer.confidence ?? null,
      at: new Date().toISOString(),
    };
    save();
  } catch (e) {
    console.error(`jev shadow route failed for ${task.id}:`, e.cause?.message || e.message);
  }
}

module.exports = { shadowRoute, pickModel, buildRequest, MAX_PROMPT_CHARS };
