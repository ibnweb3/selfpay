// Bundles the dashboard: copies ABIs + deployment manifests into web/src, then esbuild -> web/app.js
import fs from 'node:fs'
import { build } from 'esbuild'

fs.mkdirSync('web/src/abi', { recursive: true })
for (const n of ['DeviceRegistry', 'RevenueVault', 'LoanPool']) {
  const { abi } = JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8'))
  fs.writeFileSync(`web/src/abi/${n}.json`, JSON.stringify(abi))
}
const PREFERRED = ['base-sepolia', 'tempo-moderato', 'arbitrum-sepolia']
const deployments = fs
  .readdirSync('deployments')
  .filter((f) => f.endsWith('.json'))
  .sort((a, b) => PREFERRED.indexOf(a.replace('.json', '')) - PREFERRED.indexOf(b.replace('.json', '')))
  .map((f) => JSON.parse(fs.readFileSync(`deployments/${f}`, 'utf8')))
fs.writeFileSync('web/src/deployments.json', JSON.stringify(deployments, null, 2))

// device manifests keyed by chain id, plus the pre-built event history (see scripts/snapshot.mjs)
const devices = {}
for (const f of fs.existsSync('devices') ? fs.readdirSync('devices') : []) {
  const dep = JSON.parse(fs.readFileSync(`deployments/${f}`, 'utf8'))
  devices[dep.chainId] = JSON.parse(fs.readFileSync(`devices/${f}`, 'utf8'))
}
fs.writeFileSync('web/src/devices.json', JSON.stringify(devices, null, 2))
if (!fs.existsSync('web/src/history.json')) fs.writeFileSync('web/src/history.json', '{}')

await build({
  entryPoints: ['web/src/main.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outfile: 'web/app.js',
  logLevel: 'info',
})
