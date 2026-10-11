// Amina's story: a short, self-playing cartoon (SVG + CSS) that explains Selfpay to a small energy business owner.
// Scenes are drawn in story.html / testnet.html. This file drives timing and the kinetic headline. There are no buttons:
// it plays while it is on screen, pauses when it is not, and loops.
// In `head`, words between *asterisks* are highlighted. `tone` recolours the highlight for the lock scenes.
const SCENES = [
  { head: 'Meet *Amina.*', sub: 'She rents solar power to her neighbours.', say: "Hi, I'm Amina!", mood: 'smile', dur: 4000 },
  { head: 'Want a *loan?* Banks say *no.*', sub: 'Too much paperwork for a loan this small.', say: 'I need 10 more units!', mood: 'worry', dur: 4200 },
  { head: 'Enter *Selfpay.*', sub: 'Lenders everywhere fund one shared pool.', say: 'A pool of lenders?', mood: 'wow', dur: 4000 },
  { head: 'Every unit gets its *own vault.*', sub: 'Customers pay the vault, not Amina.', say: 'Customers pay the vault!', mood: 'smile', dur: 4200 },
  { head: 'Borrow against what it *earns.*', sub: 'Sized by real payments, not paperwork.', say: 'Cash for more units!', mood: 'smile', dur: 4400 },
  { head: 'The loan *pays itself* back.', sub: 'Lender first. Amina keeps the rest.', say: 'Lender first, then me.', mood: 'smile', dur: 4800 },
  { head: 'Payments stop? The unit *locks.*', sub: 'All revenue goes to the lender.', say: 'Uh-oh. Payments stopped.', mood: 'worry', dur: 4800, tone: 'bad' },
  { head: 'Catch up. Power is *back on.*', sub: 'Pay what is late and the lock lifts.', say: 'Caught up! Power is on.', mood: 'smile', dur: 4200 },
  { head: 'A loan the machine *pays back itself.*', sub: 'Built for small energy businesses. Live on test networks.', say: '', mood: 'smile', dur: 5200, tone: 'finale' },
]

const $ = (id) => document.getElementById(id)
const stage = $('stage')

if (stage) {
  const wrap = $('stageWrap')
  const ad = $('ad')
  const say = $('say')
  const bar = $('progressBar')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const framed = window.parent !== window
  let i = 0
  let playing = false
  let timer = null
  let startedAt = 0
  let remaining = 0
  let started = false
  let tabVisible = !document.hidden
  let hostVisible = null // framed: the page that embeds us says when we are on screen (null = not told yet)
  let selfVisible = false // standalone: our own viewport

  // headline -> one animated span per word; *starred* words get the highlight + underline sweep
  function renderHeadline(text) {
    const plain = text.replaceAll('*', '')
    let em = false
    let idx = 0
    const html = text.split('*').map((chunk, k) => {
      em = k % 2 === 1
      return chunk.split(' ').filter(Boolean).map((w) => `<span class="w${em ? ' em' : ''}" style="--i:${idx++}" aria-hidden="true">${w}</span>`).join('')
    }).join('')
    const head = $('adHead')
    head.innerHTML = html
    head.setAttribute('aria-label', plain)
    return idx
  }

  function show(n) {
    i = ((n % SCENES.length) + SCENES.length) % SCENES.length
    const s = SCENES[i]
    stage.dataset.scene = String(i + 1)
    wrap.dataset.scene = String(i + 1)
    stage.dataset.mood = s.mood
    ad.dataset.tone = s.tone || 'default'
    $('adStep').textContent = `Step ${i + 1} of ${SCENES.length}`
    const words = renderHeadline(s.head)
    const sub = $('adSub')
    sub.textContent = s.sub
    sub.style.setProperty('--n', String(words))
    sub.style.animation = 'none'
    void sub.offsetWidth
    sub.style.animation = ''
    say.textContent = s.say
    say.style.animation = 'none'
    void say.offsetWidth
    say.style.animation = ''
    bar.classList.remove('run')
    bar.style.width = '0'
    void bar.offsetWidth
    bar.style.setProperty('--dur', `${s.dur}ms`)
    bar.classList.add('run')
    remaining = s.dur
  }

  // every scene (the finale too) has a duration, so the story loops by itself
  function schedule() {
    clearTimeout(timer)
    if (!playing) return
    startedAt = performance.now()
    timer = setTimeout(() => { show(i + 1); schedule() }, remaining)
  }

  function setPlaying(p) {
    if (p === playing) return
    if (!p && timer) { clearTimeout(timer); remaining = Math.max(300, remaining - (performance.now() - startedAt)) }
    playing = p
    if (p && !started) { started = true; show(0) } // first play: restart scene 1 so the viewer sees it from its beginning
    wrap.classList.toggle('paused', !p && started) // before the first play nothing is frozen, so no part of the picture can be left invisible
    if (p) schedule()
  }

  // plays only while it can be seen: the tab is visible, and the page that embeds it (or this page) has it on screen
  function update() {
    const onScreen = framed ? hostVisible === true : selfVisible
    setPlaying(!reduce && tabVisible && onScreen)
  }

  show(0)

  if (framed) {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return
      if (e.data.selfpayStory === 'pause') hostVisible = false
      else if (e.data.selfpayStory === 'resume') hostVisible = true
      else return
      update()
    })
    // a host that never sends a message (the dialog in the app) simply gets a story that plays
    setTimeout(() => { if (hostVisible === null) { hostVisible = true; update() } }, 700)
  } else {
    new IntersectionObserver(([entry]) => { selfVisible = entry.isIntersecting; update() }, { threshold: 0.45 }).observe(wrap)
  }
  document.addEventListener('visibilitychange', () => { tabVisible = !document.hidden; update() })

  // people who ask their device for reduced motion get a still picture; a tap on it moves to the next step
  if (reduce) {
    wrap.style.cursor = 'pointer'
    wrap.setAttribute('role', 'button')
    wrap.setAttribute('tabindex', '0')
    wrap.setAttribute('aria-label', 'Show the next step of the story')
    wrap.addEventListener('click', () => show(i + 1))
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(i + 1) } })
  }
}
