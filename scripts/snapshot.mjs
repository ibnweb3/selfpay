// Pre-builds each device's event history so the dashboard only has to fetch the recent tail live.
// Needed because public RPCs limit eth_getLogs ranges (Base Sepolia: 200 blocks).  Run before build-web.
import fs from 'node:fs'
import { createPublicClient, http } from 'viem'
import { getEventsChunked } from '../web/src/chunked.mjs'

const abi = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8')).abi
const vaultAbi = abi('RevenueVault')
const registryAbi = abi('DeviceRegistry')

const out = {}
for (const f of fs.readdirSync('deployments').filter((x) => x.endsWith('.json'))) {
  const dep = JSON.parse(fs.readFileSync(`deployments/${f}`, 'utf8'))
  const mf = `devices/${f}`
  if (!fs.existsSync(mf)) continue
  const client = createPublicClient({ transport: http(dep.rpc) })
  const latest = await client.getBlockNumber()
  for (const d of JSON.parse(fs.readFileSync(mf, 'utf8'))) {
    const range = dep.logRange || 50000
    const [v, r] = await Promise.all([
      getEventsChunked(client, { address: d.vault, abi: vaultAbi }, d.block, latest, range),
      getEventsChunked(client, { address: dep.registry, abi: registryAbi, eventName: 'ReadingReported', args: { deviceId: d.deviceId } }, d.block, latest, range),
    ])
    const events = [...v, ...r]
    const blocks = [...new Set(events.map((e) => e.blockNumber))]
    const ts = new Map()
    for (let i = 0; i < blocks.length; i += 6) {
      await Promise.all(blocks.slice(i, i + 6).map(async (b) => ts.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp))))
    }
    out[`${dep.chainId}:${d.deviceId}`] = {
      upTo: Number(latest),
      events: events.map((e) => ({ eventName: e.eventName, args: e.args, blockNumber: e.blockNumber, logIndex: e.logIndex, transactionHash: e.transactionHash, ts: ts.get(e.blockNumber) })),
    }
    console.log(f, d.name, events.length, 'events up to block', Number(latest))
  }
}
fs.writeFileSync('web/src/history.json', JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? `bi:${v}` : v)))
