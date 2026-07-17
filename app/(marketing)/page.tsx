import Link from 'next/link';
import ThemeToggle from '@/components/ThemeToggle';

/* eslint-disable @next/next/no-img-element */

const FORMS = [
  {
    n: '01',
    title: 'Write the card',
    body: 'Title, acceptance criteria, priority. The brief is the discipline.',
  },
  {
    n: '02',
    title: 'Choose the fighter',
    body: 'Pick the model and effort per card. Haiku for drills, Opus for the tournament.',
  },
  {
    n: '03',
    title: 'The Manager dispatches',
    body: 'Suggest, semi, or full auto. The sensei watches the queue.',
  },
  {
    n: '04',
    title: 'Review and ship',
    body: 'Repo cards open real PRs. You hold the merge button.',
  },
];

const FEATURES = [
  { k: 'MODELS', t: 'Every fighter on the card', b: 'Claude Fable, Opus, Sonnet, Haiku — plus GPT-5.6 and Gemini. Route each card to the right model.' },
  { k: 'EFFORT', t: 'Belt-stripe effort', b: 'Low to max, set per card. Spend reasoning where the work deserves it.' },
  { k: 'MANAGER', t: 'A sensei for the queue', b: 'Triages new cards, dispatches runs, reviews results against your acceptance criteria.' },
  { k: 'SANDBOX', t: 'Repo cards ship PRs', b: 'Coding tasks clone your repo in an isolated sandbox and open a pull request when done.' },
  { k: 'KEYS', t: 'Bring your own keys', b: 'Usage bills straight to your provider accounts. Keys are AES-256-GCM encrypted at rest.', fn: 'your keys never leave your server. obviously.' },
  { k: 'LOG', t: 'Everything on the record', b: 'Every manager decision and agent run lands in a plain, scannable activity log.' },
];

function DemoCard({ title, meta, running, done, failed, pr }: {
  title: string; meta: React.ReactNode; running?: boolean; done?: boolean; failed?: boolean; pr?: string;
}) {
  return (
    <div className={`card ${running ? 'running-card brush' : ''} ${done ? 'done-card' : ''} ${failed ? 'failed-card' : ''}`}>
      {done && <span className="seal card-seal">Shipped</span>}
      <div className="title">
        {running && <span className="antenna lit" aria-hidden />}
        {title}
      </div>
      <div className="meta">
        {meta}
        {running && <span className="runword">running</span>}
        {failed && <span className="failword">failed</span>}
        {pr && <span className="pr-link">{pr}</span>}
      </div>
    </div>
  );
}

function Stripes({ n }: { n: number }) {
  return (
    <span className="stripes" title={`effort ${n}/4`} aria-label={`effort level ${n} of 4`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}
    </span>
  );
}

export default function Landing() {
  return (
    <div className="mkt">
      <header className="masthead">
        <div className="mkt-inner">
          <Link href="/" className="wordmark">
            Kungfu Kanban <span className="antenna" aria-hidden />
          </Link>
          <nav aria-label="Site">
            <a href="#forms">The four forms</a>
            <a href="#pricing">Pricing</a>
            <a href="https://github.com/LeahyCC/kungfu-kanban" target="_blank" rel="noreferrer">GitHub</a>
            <ThemeToggle />
            <Link href="/board" className="btn ink">Enter the dojo</Link>
          </nav>
        </div>
      </header>

      <main>
        {/* HERO */}
        <section className="hero">
          <div className="mkt-inner hero-grid">
            <div>
              <h1>
                <span className="line"><span style={{ ['--i' as never]: 0 }}>Every card</span></span>
                <span className="line"><span style={{ ['--i' as never]: 1 }}>is a fighter.</span></span>
                <span className="line">
                  <span style={{ ['--i' as never]: 2 }}>
                    You are the master.
                    <span className="seal hero-beta-seal">Free beta</span>
                  </span>
                </span>
              </h1>
              <p className="hero-sub">
                Kungfu Kanban is a board where each card runs an AI agent on your keys —
                Claude, GPT, Gemini — and a Manager triages the queue while you review the PRs.
              </p>
              <div className="hero-ctas">
                <Link href="/board" className="btn primary">Enter the dojo — free</Link>
                <a href="#forms" className="btn ghost">Read the manifesto</a>
              </div>
            </div>
            <figure className="hero-figure">
              <img src="/icons/ms-icon-310x310.png" alt="The Kungfu Kanban robot — a cardboard box robot held together with duct tape" width={200} height={200} />
              <figcaption className="fig-caption">fig. 1 — the student. cardboard, tape, ships PRs.</figcaption>
            </figure>
          </div>
        </section>

        {/* THE FOUR FORMS */}
        <section className="forms-section section-pad" id="forms">
          <div className="mkt-inner">
            <h2 className="section-title">The four forms.</h2>
            {FORMS.map((f) => (
              <div className="form-band" key={f.n}>
                <div className="form-num" aria-hidden>{f.n}</div>
                <div className="form-body">
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* LIVE BOARD REPLICA */}
        <section className="live-band">
          <div className="mkt-inner">
            <h2>It is a kanban board.<br />The cards do the work.</h2>
            <div className="live-board" aria-label="Product preview: the kanban board">
              <div className="column" data-status="backlog">
                <div className="col-head"><span className="col-name">Backlog</span><span className="col-count">2</span></div>
                <div className="col-body">
                  <DemoCard title="Write onboarding email sequence" meta={<><span className="badge model">sonnet</span><Stripes n={2} /></>} />
                  <DemoCard title="Summarize competitor pricing pages" meta={<><span className="badge model">haiku</span><Stripes n={1} /></>} />
                </div>
              </div>
              <div className="column" data-status="running">
                <div className="col-head"><span className="col-name">In Progress</span><span className="col-count">1</span></div>
                <div className="col-body">
                  <DemoCard running title="Fix flaky auth test in CI" meta={<><span className="badge model">opus</span><Stripes n={3} /><span className="prio-high" title="High priority" /></>} />
                </div>
              </div>
              <div className="column" data-status="review">
                <div className="col-head"><span className="col-name">Review</span><span className="col-count">2</span></div>
                <div className="col-body">
                  <DemoCard title="Add healthcheck endpoint" meta={<><span className="badge model">sonnet</span><Stripes n={2} /></>} pr="PR #142" />
                  <DemoCard failed title="Migrate icons to SVG sprites" meta={<><span className="badge model">gpt-5.6</span><Stripes n={2} /></>} />
                </div>
              </div>
              <div className="column" data-status="done">
                <div className="col-head"><span className="col-name">Done</span><span className="col-count">2</span></div>
                <div className="col-body">
                  <DemoCard done title="Refactor webhook retries" meta={<><span className="badge model">opus</span><Stripes n={4} /></>} pr="PR #138" />
                  <DemoCard done title="Draft changelog for v0.4" meta={<><span className="badge model">haiku</span><Stripes n={1} /></>} />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FEATURES — newspaper grid */}
        <section className="features-section section-pad">
          <div className="mkt-inner">
            <h2 className="section-title">The discipline, itemized.</h2>
            <div className="paper-grid">
              {FEATURES.map((f) => (
                <div className="paper-cell" key={f.k}>
                  <span className="kicker">{f.k}</span>
                  <h3>{f.t}</h3>
                  <p>{f.b}</p>
                  {f.fn && <span className="footnote">{f.fn}</span>}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* THE INK BAND — the sensei */}
        <section className="ink-band">
          <div className="mkt-inner">
            <div>
              <h2>A sensei for the queue.</h2>
              <p>
                The Manager reads every card, routes it to the right model, launches runs,
                and reviews the results against your acceptance criteria. You choose how
                much rope it gets.
              </p>
            </div>
            <div className="ladder-demo" aria-label="Autonomy levels">
              <div className="rung">
                <b>Suggest</b>
                <div className="bar" />
                <small>every action waits for your approval</small>
              </div>
              <div className="rung">
                <b>Semi</b>
                <div className="bar" />
                <small>creates and runs cards; verdicts need your sign-off</small>
              </div>
              <div className="rung">
                <b>Auto</b>
                <div className="bar" />
                <small>full autopilot, inside your guardrails</small>
              </div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section className="pricing-section section-pad" id="pricing">
          <div className="mkt-inner">
            <h2 className="section-title">Two belts.</h2>
            <div className="pricing-grid">
              <div className="plan">
                <h3>White Belt</h3>
                <ul>
                  <li>Free while in beta</li>
                  <li>All models, your keys</li>
                  <li>The Manager, suggest &amp; semi</li>
                </ul>
                <Link href="/board" className="btn ink">Start now</Link>
              </div>
              <div className="plan pro-plan">
                <span className="seal plan-seal">Soon</span>
                <h3>Black Belt</h3>
                <ul>
                  <li>Unlimited cards, 5 running at once</li>
                  <li>Repo cards — sandboxed agents, real PRs</li>
                  <li>Manager autopilot</li>
                </ul>
                <span className="footnote">stripe checkout · when it&apos;s ready · no lock-in.</span>
              </div>
            </div>
          </div>
        </section>

        {/* COLOPHON */}
        <footer className="colophon">
          <div className="mkt-inner">
            <div className="colophon-grid">
              <div>
                <b>Product</b>
                <Link href="/board">The board</Link>
                <Link href="/manager">The Manager</Link>
                <Link href="/billing">Pricing</Link>
              </div>
              <div>
                <b>Source</b>
                <a href="https://github.com/LeahyCC/kungfu-kanban" target="_blank" rel="noreferrer">GitHub</a>
                <Link href="/settings">Your keys</Link>
              </div>
              <div>
                <b>Colophon</b>
                <span style={{ color: 'var(--ink-400)' }}>© {new Date().getFullYear()} Kungfu Kanban</span>
              </div>
            </div>
            <div className="colophon-bow">
              <img src="/icons/android-icon-48x48.png" alt="" width={48} height={48} />
              <p>
                Set in Fraunces, Instrument Sans &amp; IBM Plex Mono.
                Ink, paper, and one cardboard robot. No stock photos.
              </p>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
