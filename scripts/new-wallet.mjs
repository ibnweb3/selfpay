// Generates a throwaway TESTNET deployer key. Writes the key to .env only; prints the address.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { existsSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) {
  console.error('.env already exists - refusing to overwrite')
  process.exit(1)
}
const pk = generatePrivateKey()
const { address } = privateKeyToAccount(pk)
writeFileSync('.env', `# THROWAWAY TESTNET KEY - never fund with real money, never commit\nDEPLOYER_PRIVATE_KEY=${pk}\nDEPLOYER_ADDRESS=${address}\n`)
writeFileSync('.env.example', 'DEPLOYER_PRIVATE_KEY=\nDEPLOYER_ADDRESS=\n')
console.log(address)
