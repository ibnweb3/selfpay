# Selfpay demo video script (about 3 minutes)

Live site: https://selfpay.ibnweb3lab.workers.dev
Method: one uncut ElevenLabs take plus a screen recording driven against the audio clock (see `demo-video-kit/README.md`). No captions.

## The 10-second story (what a judge must remember)
Amina rents solar power to her neighbours. Banks will not write a loan this small. Selfpay lends against her meter, and the meter repays the loan. If payments stop, the unit locks.

## Voice-over, scene by scene
Each scene is written to continue the sentence before it, so the take sounds like one person talking. Numbers are spelled the way they are said. Paste the scenes into `SCENES` in `tts-single-take.mjs`, joined by single spaces.

| # | Time | On screen | Voice-over |
|---|------|-----------|------------|
| 1 | 0:00 | Landing hero: solar panel and battery image, headline, pool and fee boxes | Amina rents solar power to her neighbours, and she wants ten more units, but no bank will write a loan this small, so we built Selfpay, a loan that the machine pays back by itself. |
| 2 | 0:17 | Scroll to "How it works". The cartoon plays beside the four steps (leave it running through scenes 2 and 3) | Here is how it works. Lenders fund one shared pool, every unit gets its own vault, her customers pay the vault, and the vault pays the lender first, and if payments stop the unit locks, and when she catches up it switches back on. |
| 3 | 0:38 | Click "Get started". Sign-up page: type the name, pick Borrow, click the wallet button, approve the signature | Amina signs up with her wallet, one signature and no password, and she picks borrower, and everything you see is live on testnet, on Base, Arbitrum and Tempo. |
| 4 | 0:53 | App, "My meter": enter the meter number, register. The meter face counts up, then the fourteen day chart | She enters her meter number and the meter starts reporting what her unit sells today and over the last fourteen days, and in this demo the readings are test data, because real meter hardware is the next step. |
| 5 | 1:14 | "Borrow": the score ring and three factor bars, then the limit buttons. Pick Tempo, drag to about one hundred thirty five dollars, click Review and borrow, confirm | Now the part a bank cannot do, we score her meter on uptime, on how steady her income is, and on how long we have seen it, and that score sets her limit, about two hundred and thirty dollars over twenty eight days, so she picks Tempo and takes a hundred and thirty five, and the fee is three percent, with every weekly instalment shown before she confirms. |
| 6 | 1:47 | "My loan": ring, instalments, the table of where customer money went | From here her customers repay the loan, seventy percent of every payment goes to the pool until it is paid and she keeps the rest, and in the demo one day lasts one minute, so you can watch a whole loan in a single sitting. |
| 7 | 2:09 | "My meter" > Cut the power (five days). Cut to the prepared account where the unit is already locked: red lock banner and the overdue instalment on "My loan" | Now we cut her power, her unit sells nothing, an instalment goes late and the unit locks, and all her revenue goes to the lender until she catches up, and when she does, the lock lifts. |
| 8 | 2:28 | Switch to the lender account: Deposit page. Pick Arbitrum and USDC, type five hundred, choose thirty days, point at the three outcomes, confirm. Positions page with the lock countdown | On the other side a lender picks a chain and a token, an amount and a lock period, and before depositing they see three outcomes, cautious, expected and strong, and we say plainly these are assumptions and not promises, then the money goes into one shared pool and the lock is enforced. |
| 9 | 2:55 | "Pool" page (liquidity by chain), then the live on-chain monitor page | Underneath, real contracts run on three testnets, a registry, a vault for every device and the pool, and this monitor reads them live, loans, repayments and lock requests included. |
| 10 | 3:10 | Back to the landing hero, hold on the headline | It is on testnet and unaudited, and the lock is an on-chain request today, and if we win we will audit the contracts, build the lock hardware that plugs into pay as you go solar units, and run a first pilot, Selfpay, a loan the machine pays back by itself. |

About 430 words, roughly three minutes at a natural pace.

## Say, and do not say
Say: testnet, test funds, test data, unaudited, roadmap, "if we win".
Do not say: "simulated", any partner, pilot customer or bank by name, any real money figure, "audited", "live in Nigeria", "real hardware" as if it exists today.
Be ready for the judge question "is the meter real?": the readings are test data today. The design is a signed meter feed, and that is what the hardware step builds.

## Preparing the recording (the demo clock is one day per minute)
1. Two wallets in the browser profile used for recording: one borrower, one lender. A real wallet extension is needed on the live site (the mock wallet exists only on the local dev server).
2. About fifteen minutes before recording, on the borrower account: register the meter, borrow, then cut the power for five days. A late instalment needs the first due day plus the two day grace, about nine minutes, so by recording time the loan is locked. Keep that account for scene 7.
3. A second, clean borrower account for scenes 3 to 6, so the registration and borrowing happen live on camera. Borrow about one hundred thirty five dollars, then keep the camera on the loan page only briefly, since no payment has landed yet.
4. Lender account: have a position already open from earlier, so scene 8 can show a countdown in "Positions".
5. Check the pool still shows enough ready cash (it starts at five thousand dollars) and that both accounts are signed in before the take.

## Delivery
- Run `DRY=1 node tts-single-take.mjs` first, fix every `LATE` line, then the real run, `record-driven.mjs`, `mix.mjs`.
- Voice settings: eleven_v4, stability 0.18, similarity 0.75, style 0.65, speaker boost off.
- Verify by measurement (silence gaps, about minus sixteen LUFS, a frame sheet), and listen once yourself.
- Delete or rotate the ElevenLabs key file afterwards.
