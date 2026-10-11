// Re-shapes the story section: compact heading, side-by-side "ad" panel, and ~half-length animation timings.
import fs from 'node:fs'

let html = fs.readFileSync('web/index.html', 'utf8')

// 1) compact heading (drop the long paragraph)
html = html.replace(
  /<div class="story-head">[\s\S]*?<\/div>\n\n    <div class="story-card">/,
  `<div class="story-head">
      <div class="eyebrow">Amina's story · 35 seconds</div>
      <h2 id="storyTitle">Want a loan? Here's how Selfpay works.</h2>
    </div>

    <div class="story-card" id="storyCard">`,
)

// 2) replace the caption/controls block with the big animated "ad" panel
const start = html.indexOf('<div class="story-ui">')
const endMarker = '<p class="story-foot">'
const footEnd = html.indexOf('</p>', html.indexOf(endMarker)) + 4
const controls = html.slice(html.indexOf('<div class="story-controls">', start), html.indexOf(endMarker))
const adPanel = `<div class="ad" id="ad" data-tone="default">
        <div class="ad-step" id="adStep">Step 1 of 9</div>
        <h3 class="ad-h" id="adHead" aria-live="polite" aria-atomic="true"></h3>
        <p class="ad-sub" id="adSub"></p>
        ${controls.trim()}
        <p class="story-foot">A cartoon of how it works. The live dashboard below runs on test networks, and the lock is simulated.</p>
      </div>`
html = html.slice(0, start) + adPanel + html.slice(footEnd)

// 3) halve the in-scene animation delays so each scene lands in ~4 seconds
html = html.replace(/animation-delay:([\d.]+)s/g, (_, n) => `animation-delay:${(Number(n) * 0.5).toFixed(2).replace(/\.?0+$/, '')}s`)

fs.writeFileSync('web/index.html', html)
console.log({ ad: html.includes('id="adHead"'), oldUi: html.includes('story-ui'), delays: (html.match(/animation-delay:/g) || []).length })
