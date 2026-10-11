// One-off wiring for the story section: imports the player, links its stylesheet, adds the nav + hero links.
import fs from 'node:fs'

let main = fs.readFileSync('web/src/main.js', 'utf8')
if (!main.includes("import './story.js'")) {
  main = main.replace("import { getEventsChunked } from './chunked.mjs'", "import { getEventsChunked } from './chunked.mjs'\nimport './story.js'")
  fs.writeFileSync('web/src/main.js', main)
}

let html = fs.readFileSync('web/index.html', 'utf8')
if (!html.includes('href="story.css"')) html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="story.css">')
if (!html.includes('href="#story"')) html = html.replace('<a href="#top" class="on">Overview</a>', '<a href="#top" class="on">Overview</a>\n      <a href="#story">Story</a>')
if (!html.includes('Watch Amina')) {
  html = html.replace(
    '<p class="note">Live on testnet · the lock is a simulated on-chain request</p>',
    '<p class="note">Live on testnet · the lock is a simulated on-chain request · <a href="#story">▶ Watch Amina\'s story</a></p>',
  )
}
fs.writeFileSync('web/index.html', html)
console.log({ main: main.includes("import './story.js'"), css: html.includes('story.css'), nav: html.includes('href="#story"'), hero: html.includes('Watch Amina') })
