import Link from 'next/link';

export default function Landing() {
  return (
    <main>
      <section className="hero">
        <h2>🥋 Kanban for AI agents</h2>
        <p>
          Every card is an AI task. Pick the model, set the effort, write acceptance criteria,
          and run it — on your own provider API key, with results landing back on the board for review.
        </p>
        <div className="cta">
          <Link href="/board"><button className="primary">Open the board</button></Link>
          <Link href="/settings"><button>Connect a provider</button></Link>
        </div>
      </section>
      <section className="features">
        <div className="feature">
          <h3>Bring your own key</h3>
          <p>Connect your Anthropic API key (OpenAI and Google adapters coming). Keys are encrypted at rest; usage bills straight to your provider account.</p>
        </div>
        <div className="feature">
          <h3>Per-card model & effort</h3>
          <p>Fable, Opus, Sonnet, or Haiku per task, with effort from low to max — route heavy work to heavy models and quick tasks to cheap ones.</p>
        </div>
        <div className="feature">
          <h3>Review before done</h3>
          <p>Finished runs land in Review with the full result and token stats. Approve to Done, or edit the prompt and re-run.</p>
        </div>
        <div className="feature">
          <h3>Free beta</h3>
          <p>No billing during beta. Accounts, teams, and repo-aware coding tasks (clone → agent → PR) are on the roadmap.</p>
        </div>
      </section>
    </main>
  );
}
