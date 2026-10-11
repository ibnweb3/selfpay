// Moves the site to the recommended pairing: Montserrat (display/headlines) + Inter (body, weight + optical-size axes),
// JetBrains Mono for addresses. Fonts are self-hosted latin subsets copied from @fontsource-variable.
import fs from 'node:fs'

const RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const face = (family, file, weights) =>
  `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weights}; font-display: swap; src: url("fonts/${file}") format("woff2-variations"), url("fonts/${file}") format("woff2"); unicode-range: ${RANGE}; }`

// 1) copy font files, drop the old family
const src = 'node_modules/@fontsource-variable'
fs.copyFileSync(`${src}/montserrat/files/montserrat-latin-wght-normal.woff2`, 'web/fonts/montserrat-latin-wght-normal.woff2')
fs.copyFileSync(`${src}/inter/files/inter-latin-opsz-normal.woff2`, 'web/fonts/inter-latin-opsz-normal.woff2')
fs.rmSync('web/fonts/plus-jakarta-sans-latin-wght-normal.woff2', { force: true })

// 2) stylesheet: font-face block, family variables, headline retune
let css = fs.readFileSync('web/style.css', 'utf8')
const faceStart = css.indexOf('/* Self-hosted variable fonts')
const rootStart = css.indexOf(':root {')
css =
  `/* Self-hosted variable fonts (SIL OFL), latin subset only. Display: Montserrat. Body: Inter (weight + optical-size axes). Mono: JetBrains Mono. */
${face('Montserrat', 'montserrat-latin-wght-normal.woff2', '100 900')}
${face('Inter', 'inter-latin-opsz-normal.woff2', '100 900')}
${face('JetBrains Mono', 'jetbrains-mono-latin-wght-normal.woff2', '100 800')}

` + css.slice(rootStart)

css = css.replace(':root {', `:root {
  --font-display: "Montserrat", "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;`)
css = css.replace(/font: 400 16px\/1\.55 "Plus Jakarta Sans"[^;]*;/, 'font: 400 16px/1.55 var(--font-body);\n  font-optical-sizing: auto;')
css = css.replace(/\.ring text \{ font: 700 8\.6px\/1 "Plus Jakarta Sans"[^;]*;/, '.ring text { font: 700 8.4px/1 var(--font-body);')
// headline faces + retuned sizes (Montserrat is wider than the previous face)
css = css.replace(
  /h1 \{ font-size: clamp\(2rem, 5vw, 3\.75rem\); line-height: 1\.06; margin: 0 0 18px; font-weight: 700; letter-spacing: -0\.025em;/,
  'h1 { font-family: var(--font-display); font-size: clamp(1.9rem, 4.4vw, 3.3rem); line-height: 1.08; margin: 0 0 18px; font-weight: 800; letter-spacing: -0.03em;',
)
css = css.replace(/h2 \{ margin: 0; font-weight: 600;/, 'h2 { font-family: var(--font-display); margin: 0; font-weight: 700;')
css = css.replace('.brand { display: inline-flex;', '.brand { font-family: var(--font-display); display: inline-flex;')
css = css.replace('.btn { display: inline-flex;', '.btn { font-family: var(--font-display); letter-spacing: 0.01em; display: inline-flex;')
css = css.replace('.fc-big { font-size: 2.75rem; font-weight: 700;', '.fc-big { font-family: var(--font-display); font-size: 2.6rem; font-weight: 800;')
fs.writeFileSync('web/style.css', css)

// 3) story stylesheet
let story = fs.readFileSync('web/story.css', 'utf8')
story = story.replace('.stage-svg text { font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif; }', '.stage-svg text { font-family: var(--font-body); }')
story = story.replace('.story-head h2 { font-size:', '.story-head h2 { font-family: var(--font-display); font-weight: 700; font-size:')
story = story.replace(
  /\.ad-h \{ margin: 10px 0 10px; font-weight: 800; font-size: clamp\(2rem, 4\.3vw, 3\.5rem\); line-height: 1\.02; letter-spacing: -0\.035em;/,
  '.ad-h { font-family: var(--font-display); margin: 10px 0 10px; font-weight: 800; font-size: clamp(1.7rem, 3.7vw, 3rem); line-height: 1.06; letter-spacing: -0.03em;',
)
story = story.replace('.ad[data-tone="finale"] .ad-h { font-size: clamp(2.1rem, 4.6vw, 3.75rem); }', '.ad[data-tone="finale"] .ad-h { font-size: clamp(1.8rem, 3.9vw, 3.2rem); }')
story = story.replace('.ad-h { min-height: 0; font-size: clamp(1.9rem, 8vw, 3rem); }', '.ad-h { min-height: 0; font-size: clamp(1.6rem, 7vw, 2.6rem); }')
story = story.replace('.btn.small { min-height', '.btn.small { min-height')
fs.writeFileSync('web/story.css', story)

// 4) page: preload the two text fonts
let html = fs.readFileSync('web/index.html', 'utf8')
html = html.replace(
  /<link rel="preload" href="fonts\/plus-jakarta-sans-latin-wght-normal\.woff2"[^>]*>/,
  '<link rel="preload" href="fonts/montserrat-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>\n<link rel="preload" href="fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>',
)
fs.writeFileSync('web/index.html', html)

const left = (css + story + html).match(/Plus Jakarta/g)
console.log({ montserratFace: css.includes('font-family: "Montserrat"'), interFace: css.includes('font-family: "Inter"'), h1: css.includes('clamp(1.9rem, 4.4vw, 3.3rem)'), adH: story.includes('clamp(1.7rem, 3.7vw, 3rem)'), preload: html.includes('inter-latin-opsz'), leftoverPJS: left ? left.length : 0 })
