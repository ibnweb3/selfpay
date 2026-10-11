// Activity feed shared by both roles.
import { call, live, paint, html, pageTitle, empty, timeline } from './common.mjs'

export function activity(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:200px"></div>`)
  live(ctx, 8000, () => call('GET', '/api/activity'), (res) => {
    const title = pageTitle('Activity', 'Everything that has happened on your account, newest first.')
    if (!res.activity.length) {
      paint(ctx.root, html`${title}${empty({ title: 'Nothing yet', text: 'Deposits, loans, repayments and meter events will show up here.' })}`)
      return
    }
    paint(ctx.root, html`${title}<section class="card">${timeline(res.activity)}</section>`)
  })
}
