// Public RPCs cap eth_getLogs ranges (Base Sepolia: 200 blocks). Split a scan into chunks and run a few at a time.
export async function getEventsChunked(client, { address, abi, eventName, args }, fromBlock, toBlock, range = 50000, concurrency = 4) {
  const spans = []
  for (let s = BigInt(fromBlock); s <= BigInt(toBlock); s += BigInt(range)) {
    const e = s + BigInt(range) - 1n
    spans.push([s, e > BigInt(toBlock) ? BigInt(toBlock) : e])
  }
  const out = []
  let i = 0
  async function worker() {
    while (i < spans.length) {
      const [s, e] = spans[i++]
      let lastErr
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          out.push(...(await client.getContractEvents({ address, abi, eventName, args, fromBlock: s, toBlock: e })))
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
      if (lastErr) throw lastErr
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, spans.length) }, worker))
  return out
}
