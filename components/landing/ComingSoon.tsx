import Link from 'next/link'
import { ArrowRight } from '@/components/Icons'
import { Phase } from '@/components/Phase'
import { BRAND } from '@/lib/brand'
import { COMING_SOON } from '@/lib/landing/copy'
import { LandingFooter, LandingHeader } from './Chrome'
import { WaitlistForm } from './WaitlistForm'

/**
 * lastten.org while places open a few families at a time (issue #92): what the project is for,
 * and one thing to do about it - join the waitlist. Same header, footer, type and moons as the
 * homepage, which waits at /about ("Read more about the project") until the public launch.
 */
export function ComingSoon({ justDeleted }: { justDeleted: boolean }) {
  return (
    <div className="lt">
      <LandingHeader sections={false} />

      <main id="main">
        <section className="lt-hero" id="join">
          {justDeleted ? (
            <p role="status" className="lt-notice">
              Your account and everything in it has been deleted. Thank you for trying {BRAND.app}.
            </p>
          ) : null}
          <p className="st-eyebrow">
            {COMING_SOON.eyebrow} · {BRAND.project}
          </p>
          <h1 className="lt-h1">
            {COMING_SOON.headline[0]}
            <em>{COMING_SOON.headline[1]}</em>
          </h1>
          <p className="lt-lead">{COMING_SOON.lead}</p>
          <WaitlistForm />
          <p className="st-note lt-join-note">{COMING_SOON.note}</p>
          <p className="st-note">{COMING_SOON.privacy}</p>
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
            <figcaption>{BRAND.tagline}</figcaption>
          </figure>
        </section>

        <section className="lt-section" id="mission" aria-labelledby="shelf-h">
          <div className="lt-mission">
            <p className="st-eyebrow">{COMING_SOON.shelf.eyebrow}</p>
            <div>
              <h2 className="lt-statement" id="shelf-h">
                {COMING_SOON.shelf.headline[0]}
                <em>{COMING_SOON.shelf.headline[1]}</em>
              </h2>
              <p className="lt-shelf-body">{COMING_SOON.shelf.body}</p>
            </div>
          </div>
          <ol className="lt-beliefs">
            {COMING_SOON.points.map((p, i) => (
              <li key={p.title}>
                <span className="lt-num" aria-hidden>
                  {['i.', 'ii.', 'iii.'][i]}
                </span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lt-close" aria-label={COMING_SOON.more}>
          <Phase lit={1} size={34} className="lt-close-moon" />
          <div className="lt-cta">
            <a href="#join" className="st-primary lt-primary">
              {COMING_SOON.joinButton} <ArrowRight />
            </a>
            <Link href="/about" className="st-textlink">
              {COMING_SOON.more}
            </Link>
          </div>
          <p className="st-note">
            <Link href="/login" className="st-textlink">
              {COMING_SOON.signIn}
            </Link>
          </p>
        </section>
      </main>

      <LandingFooter missionHref="#mission" />
    </div>
  )
}
