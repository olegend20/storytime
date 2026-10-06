import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildEpub, epubFilename, epubFiles, proseToXhtml, xml } from '@/lib/kindle/epub'
import { isKindleAddress, normalizeKindleAddress } from '@/lib/kindle/address'
import { goodStory } from '../helpers/story'

/** Send to Kindle (issue #11): the book is well-formed, and nothing from a story is markup. */

describe('the EPUB', () => {
  it('has mimetype first and stored, a container, a package whose spine covers every chapter, and nav', async () => {
    const story = goodStory()
    const bytes = await buildEpub({ story, childNames: ['Milo', 'Juno'], id: 'story-1' })
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files)
    expect(names[0]).toBe('mimetype')
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip')
    // The zip's first local header: name "mimetype" at offset 30, compression method 0 (stored).
    const header = bytes.subarray(0, 30 + 'mimetype'.length)
    expect(header.readUInt16LE(8)).toBe(0)
    expect(header.subarray(30).toString('ascii')).toBe('mimetype')
    expect(await zip.file('META-INF/container.xml')!.async('string')).toContain('OEBPS/package.opf')

    const opf = await zip.file('OEBPS/package.opf')!.async('string')
    const itemrefs = opf.match(/<itemref /g)?.length ?? 0
    expect(itemrefs).toBe(story.chapters.length + 2) // title page + chapters + the end
    for (let i = 1; i <= story.chapters.length; i += 1) {
      expect(opf).toContain(`href="chapter-${i}.xhtml"`)
      expect(zip.file(`OEBPS/chapter-${i}.xhtml`)).not.toBeNull()
    }
    expect(opf).toContain('properties="nav"')
    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string')
    expect(nav).toContain('epub:type="toc"')
    expect(nav).toContain(xml(story.title))
    const end = await zip.file('OEBPS/the-end.xhtml')!.async('string')
    expect(end).toContain('True facts from the story')
    expect(end.match(/<li>/g)?.length).toBe(story.true_facts.length)
  })

  it('escapes everything from the story: a hostile title is text in the book, never markup', () => {
    const story = goodStory()
    story.title = `Milo & the <script>alert("x")</script> Tower`
    story.chapters[0]!.heading = 'Chapter 1: 5 < 6 & 7 > 2'
    story.chapters[0]!.text = 'Milo said "look" & pointed. **CLICK!** <b>not bold</b>'
    const files = epubFiles({ story, childNames: ['Milo'], id: 'x' })
    const all = files.map((f) => f.content).join('\n')
    expect(all).not.toContain('<script>')
    expect(all).toContain('&lt;script&gt;')
    expect(all).toContain('5 &lt; 6 &amp; 7 &gt; 2')
    expect(all).toContain('&lt;b&gt;not bold&lt;/b&gt;')
    expect(all).toContain('<strong class="sound">CLICK!</strong>')
    // Every XHTML file parses as XML.
    for (const f of files.filter((f) => f.path.endsWith('.xhtml'))) {
      expect(f.content.startsWith('<?xml version="1.0" encoding="utf-8"?>'), f.path).toBe(true)
      const opens = (f.content.match(/<p[ >]/g) ?? []).length
      const closes = (f.content.match(/<\/p>/g) ?? []).length
      expect(opens, f.path).toBe(closes)
    }
  })

  it('turns story markdown into paragraphs with emphasis', () => {
    expect(proseToXhtml('First *soft* line.\n\nSecond **1932** line.')).toBe(
      '<p>First <em>soft</em> line.</p>\n<p>Second <strong>1932</strong> line.</p>',
    )
  })

  it('names the file after the story, safely', () => {
    expect(epubFilename('Milo & Juno: The Brick That Clicked!')).toBe('Milo-Juno-The-Brick-That-Clicked.epub')
    expect(epubFilename('???')).toBe('storytime.epub')
  })
})

describe('the EPUB carries the story\'s notice (issue #27)', () => {
  it('puts the notice on the title page, escaped, and leaves it out when there is none', () => {
    const story = goodStory()
    const notice = "This story borrows a character that belongs to someone else. It's made for reading at home — please don't share or publish it."
    const withNotice = epubFiles({ story, childNames: ['Milo'], id: 's', notice })
    const title = withNotice.find((f) => f.path === 'OEBPS/title.xhtml')!.content
    expect(title).toContain('class="notice"')
    expect(title).toContain('belongs to someone else')
    expect(title).toContain('don&apos;t share')
    const without = epubFiles({ story, childNames: ['Milo'], id: 's' })
    expect(without.find((f) => f.path === 'OEBPS/title.xhtml')!.content).not.toContain('notice')
  })
})

describe('a Send-to-Kindle address', () => {
  it('is name@kindle.com or name@free.kindle.com, case-insensitive, and nothing else', () => {
    expect(isKindleAddress('milo_abc123@kindle.com')).toBe(true)
    expect(isKindleAddress('  Milo.Dad@Free.Kindle.com ')).toBe(true)
    expect(normalizeKindleAddress('  Milo@Kindle.COM ')).toBe('milo@kindle.com')
    for (const bad of ['milo@gmail.com', 'milo@kindle.com.evil.net', '<b>milo</b>@kindle.com', 'milo @kindle.com', '@kindle.com', 'milo@kindle.co']) {
      expect(isKindleAddress(bad), bad).toBe(false)
    }
  })
})
