import JSZip from 'jszip'
import { parseParagraphs, type Inline } from '@/lib/client/markdown'
import type { StoryOutput } from '@/lib/schemas'

/**
 * A story as an EPUB 3 e-book, for Send to Kindle (issue #11, DECISIONS #150).
 *
 * Built by hand rather than with a library: an EPUB is a zip with four small XML files and
 * one XHTML file per chapter, and a hand-built one is one we can read, test and escape
 * ourselves. Everything from the story goes through `xml()`: a title containing `<script>`
 * or `&` ends up as text in the book, never as markup.
 *
 * Kindle accepts EPUB by email (Send to Kindle) and converts it on arrival.
 */

export interface EpubInput {
  story: StoryOutput
  /** First names of the children, for the title page. */
  childNames: readonly string[]
  /** A stable id for the book, so re-sending replaces rather than duplicates on the device. */
  id: string
  language?: string
}

export const EPUB_MIME = 'application/epub+zip'

export function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function inline(tokens: Inline[]): string {
  return tokens
    .map((t) => {
      switch (t.kind) {
        case 'text':
          return xml(t.text)
        case 'em':
          return `<em>${xml(t.text)}</em>`
        case 'strong':
          return `<strong${t.sound ? ' class="sound"' : ''}>${xml(t.text)}</strong>`
        case 'strongEm':
          return `<strong${t.sound ? ' class="sound"' : ''}><em>${xml(t.text)}</em></strong>`
      }
    })
    .join('')
}

/** Markdown-ish story prose to XHTML paragraphs. */
export function proseToXhtml(text: string): string {
  return parseParagraphs(text)
    .map((tokens) => `<p>${inline(tokens)}</p>`)
    .join('\n')
}

function page(title: string, body: string, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(lang)}" lang="${xml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${xml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`
}

const STYLE = `body { font-family: serif; line-height: 1.6; }
h1, h2 { font-weight: 700; line-height: 1.2; }
h1 { font-size: 1.8em; margin: 1em 0 0.3em; }
h2 { font-size: 1.3em; margin: 1.4em 0 0.6em; }
p { margin: 0 0 0.9em; }
.subtitle { font-style: italic; margin-bottom: 1.5em; }
.sound { letter-spacing: 0.04em; }
.shout { text-align: center; font-weight: 700; margin: 1em 0 1.5em; }
.ending { text-align: center; font-style: italic; margin-top: 2em; }
.the-end { text-align: center; letter-spacing: 0.2em; font-size: 0.8em; margin-top: 2em; }
ul.facts { padding-left: 1.2em; }
ul.facts li { margin-bottom: 0.6em; }
`

export function joinNames(names: readonly string[]): string {
  const list = names.filter((n) => n.trim() !== '')
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]!
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The files of the book, path -> content. The order matters: `mimetype` must be first. */
export function epubFiles(input: EpubInput): { path: string; content: string }[] {
  const { story } = input
  const lang = input.language ?? 'en'
  const title = story.title
  const chapterFiles = story.chapters.map((chapter, i) => {
    const heading = chapter.heading || `Chapter ${i + 1}`
    const shout = chapter.shout_line ? `<p class="shout">${xml(chapter.shout_line)}</p>` : ''
    return {
      path: `OEBPS/chapter-${i + 1}.xhtml`,
      content: page(heading, `<h2>${xml(heading)}</h2>\n${proseToXhtml(chapter.text)}\n${shout}`, lang),
    }
  })
  const titlePage = {
    path: 'OEBPS/title.xhtml',
    content: page(
      title,
      [
        `<h1>${xml(title)}</h1>`,
        story.subtitle ? `<p class="subtitle">${xml(story.subtitle)}</p>` : '',
        input.childNames.length > 0 ? `<p>A StoryTime story for ${xml(joinNames(input.childNames))}.</p>` : '',
      ]
        .filter((s) => s !== '')
        .join('\n'),
      lang,
    ),
  }
  const endPage = {
    path: 'OEBPS/the-end.xhtml',
    content: page(
      'The End',
      [
        `<p class="the-end">THE END</p>`,
        `<p class="ending">${xml(story.ending_line)}</p>`,
        `<h2>True facts from the story</h2>`,
        `<ul class="facts">${story.true_facts.map((f) => `<li>${inline(parseParagraphs(f.text).flat())}</li>`).join('')}</ul>`,
      ].join('\n'),
      lang,
    ),
  }
  const pages = [titlePage, ...chapterFiles, endPage]
  const items = pages.map((p, i) => ({ id: `p${i}`, href: p.path.replace('OEBPS/', '') }))

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${xml(input.id)}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    <dc:language>${xml(lang)}</dc:language>
    <dc:creator>StoryTime</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${items.map((it) => `    <item id="${it.id}" href="${xml(it.href)}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${items.map((it) => `    <itemref idref="${it.id}"/>`).join('\n')}
  </spine>
</package>
`
  const nav = page(
    'Contents',
    `<nav epub:type="toc" id="toc"><h2>Contents</h2><ol>
${pages.map((p, i) => `<li><a href="${xml(p.path.replace('OEBPS/', ''))}">${xml(i === 0 ? title : i === pages.length - 1 ? 'The End' : story.chapters[i - 1]!.heading || `Chapter ${i}`)}</a></li>`).join('\n')}
</ol></nav>`,
    lang,
  )

  return [
    { path: 'mimetype', content: EPUB_MIME },
    {
      path: 'META-INF/container.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
    },
    { path: 'OEBPS/package.opf', content: opf },
    { path: 'OEBPS/nav.xhtml', content: nav },
    { path: 'OEBPS/style.css', content: STYLE },
    ...pages,
  ]
}

/** The book as bytes. `mimetype` is first and stored uncompressed, as the format requires. */
export async function buildEpub(input: EpubInput): Promise<Buffer> {
  const zip = new JSZip()
  for (const file of epubFiles(input)) {
    zip.file(file.path, file.content, {
      compression: file.path === 'mimetype' ? 'STORE' : 'DEFLATE',
    })
  }
  return zip.generateAsync({ type: 'nodebuffer', mimeType: EPUB_MIME })
}

/** A filename a mail client and a Kindle are both happy with. */
export function epubFilename(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `${slug || 'storytime'}.epub`
}
