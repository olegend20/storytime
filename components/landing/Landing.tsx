import Link from 'next/link'
import { ArrowRight, Check, ChevronDown } from '@/components/Icons'
import { Phase } from '@/components/Phase'
import { BRAND } from '@/lib/brand'
import { ThemeToggle } from '@/components/ThemeToggle'
import { BELIEFS, CLOSING, HERO, HOW, KINDLE, MISSION, PROMISES, QUESTIONS, SAMPLE } from '@/lib/landing/copy'

/**
 * lastten.org (issue #17): the mission in one screen, and one thing to do about it.
 *
 * A server component with no client JavaScript of its own: the ten moons arrive with a CSS
 * stagger, the questions are native <details>, and every link is a real link. The action
 * always points at the creator: the proxy sends a signed-out visitor through sign-in and back
 * (`/login?next=/new`), so there is one path and no auth logic here.
 */
export function Landing({
  justDeleted,
  kindle,
}: {
  justDeleted: boolean
  /** This server can send to a Kindle, so the page may say so. */
  kindle: boolean
}) {
  const start = '/new'

  return (
    <div className="lt">
      <header className="st-header">
        <div className="st-header-in">
          <Link href="/" className="st-brand" aria-label={`${BRAND.wordmark}, home`}>
            <span className="st-wordmark">{BRAND.wordmark}</span>
            <span className="st-byline">{BRAND.wordmarkByline}</span>
          </Link>
          <nav className="st-nav" aria-label="Main">
            <a href="#mission" className="st-navlink st-hide-sm">
              Our mission
            </a>
            <a href="#how" className="st-navlink st-hide-sm">
              How it works
            </a>
            <Link href="/login" className="st-navlink">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="lt-hero">
          {justDeleted ? (
            <p role="status" className="lt-notice">
              Your account and everything in it has been deleted. Thank you for trying {BRAND.app}.
            </p>
          ) : null}
          <p className="st-eyebrow">{HERO.eyebrow}</p>
          <h1 className="lt-h1">
            {HERO.headline[0]}
            <em>{HERO.headline[1]}</em>
          </h1>
          <p className="lt-lead">{HERO.lead}</p>
          <div className="lt-cta">
            <Link href={start} className="st-primary lt-primary">
              {HERO.cta} <ArrowRight />
            </Link>
            <a href="#mission" className="st-textlink">
              {HERO.secondary}
            </a>
          </div>
          <p className="st-note">{HERO.note}</p>
          <figure className="lt-moons">
            <div
              className="lt-moons-row"
              role="img"
              aria-label="Ten moons, waxing from new to full: one for each of the last ten minutes of the day"
            >
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} style={{ animationDelay: `${300 + i * 140}ms` }}>
                  <Phase lit={(i + 1) / 10} size={36} />
                </span>
              ))}
            </div>
            <figcaption>{HERO.moons}</figcaption>
          </figure>
        </section>

        <section className="lt-section" id="mission" aria-labelledby="mission-h">
          <div className="lt-mission">
            <h2 className="st-eyebrow" id="mission-h">
              Our mission
            </h2>
            <p className="lt-statement">
              {MISSION[0]}
              <em>{MISSION[1]}</em>
              {MISSION[2]}
            </p>
          </div>
          <ol className="lt-beliefs">
            {BELIEFS.map((b) => (
              <li key={b.n}>
                <span className="lt-num" aria-hidden>
                  {b.n}
                </span>
                <h3>{b.title}</h3>
                <p>{b.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lt-section lt-how" id="how" aria-labelledby="how-h">
          <div>
            <p className="st-eyebrow">{HOW.eyebrow}</p>
            <h2 className="lt-h2" id="how-h">
              {HOW.headline}
            </h2>
            <ol className="lt-steps">
              {HOW.steps.map((s, i) => (
                <li key={s.title}>
                  <span className="lt-step-n" aria-hidden>
                    {i + 1}
                  </span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="lt-aside">{HOW.aside}</p>
          </div>
          <aside className="st-sample" aria-label={SAMPLE.label}>
            <p className="st-sample-label">{SAMPLE.label}</p>
            <div className="st-book">
              <p className="st-book-by">{SAMPLE.byline}</p>
              <p className="st-book-title">{SAMPLE.title}</p>
              <div className="st-ornament" aria-hidden>
                <i />
                <Phase lit={0.28} size={13} />
                <i />
              </div>
              <div className="st-book-prose">
                <p className="st-dropcap">{SAMPLE.paragraphs[0]}</p>
                <p>{SAMPLE.paragraphs[1]}</p>
              </div>
              <span className="st-book-folio" aria-hidden>
                1
              </span>
            </div>
            <div className="lt-fact">
              <span className="lt-fact-label">{SAMPLE.factLabel}</span>
              <p>{SAMPLE.fact}</p>
            </div>
          </aside>
        </section>

        <section className="lt-band" aria-labelledby="promise-h">
          <div className="lt-band-in">
            <p className="st-eyebrow">What we promise families</p>
            <h2 className="lt-h2" id="promise-h">
              Quiet, honest, and on your side.
            </h2>
            <ul className="lt-promises">
              {PROMISES.map((p) => (
                <li key={p.title}>
                  <span className="lt-tick" aria-hidden>
                    <Check width={13} height={13} />
                  </span>
                  <div>
                    <h3>{p.title}</h3>
                    <p>
                      {p.body}
                      {kindle && p.title === KINDLE.promiseTitle ? KINDLE.promise : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lt-section lt-faq" aria-labelledby="faq-h">
          <p className="st-eyebrow">Good to know</p>
          <h2 className="lt-h2" id="faq-h">
            The questions parents ask first.
          </h2>
          <div className="lt-qs">
            {QUESTIONS.map((item, i) => (
              <details key={item.q} className="lt-q" open={i === 0}>
                <summary>
                  <h3>{item.q}</h3>
                  <ChevronDown width={18} height={18} className="st-chev" />
                </summary>
                <p className="lt-a">
                  {item.a}
                  {kindle && item.q === KINDLE.question ? KINDLE.answer : ''}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section className="lt-close" aria-labelledby="close-h">
          <Phase lit={1} size={34} className="lt-close-moon" />
          <h2 className="lt-h1 lt-h1-close" id="close-h">
            {CLOSING.headline[0]}
            <em>{CLOSING.headline[1]}</em>
          </h2>
          <p className="lt-lead">{CLOSING.lead}</p>
          <div className="lt-cta">
            <Link href={start} className="st-primary lt-primary">
              {HERO.cta} <ArrowRight />
            </Link>
          </div>
        </section>
      </main>

      <footer className="st-footer">
        <div className="st-footer-in">
          <span>
            {BRAND.project} · {BRAND.app} is our bedtime story app.
          </span>
          <span className="st-footer-links">
            <a href="#mission">Our mission</a>
            <Link href="/privacy">Privacy</Link>
            <ThemeToggle compact />
          </span>
        </div>
      </footer>
    </div>
  )
}
