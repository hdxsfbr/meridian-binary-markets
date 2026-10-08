---
title: Quick start
order: 1
---

# Quick start

Meridian runs on a test network with test money. Nothing here is real cash — see
[FAQ and limits](/docs/faq-and-limits) for what that means. This page gets you from a fresh
wallet to your first trade.

## 1. Set up your wallet

Install [Phantom](https://phantom.app) or [Solflare](https://solflare.com) if you don't already
have one, then switch its network:

- **Phantom:** Settings → Developer Settings → turn on Testnet Mode, then select the exact
  network named in [FAQ and limits](/docs/faq-and-limits).
- **Solflare:** use the network selector and choose that same network.

Use that same network again for the Circle faucet below.

## 2. Get test SOL and test USDC

You need a small amount of SOL to pay transaction fees, and USDC to trade with. Both are free on
this network:

- **Test SOL:** go to [faucet.solana.com](https://faucet.solana.com), paste your wallet address,
  and request 1 SOL. That covers fees for a long session.
- **Test USDC:** go to [faucet.circle.com](https://faucet.circle.com), choose asset **USDC** and
  the network you selected above, paste your address, and send 20 USDC. You can request again
  from the same address every two hours.

## 3. Connect

Open the app and click **Select Wallet** in the top right, choose your wallet, and approve the
connection. Once connected, the nav shows your wallet address and your Portfolio page shows your
USDC balance.

## 4. Your first trade

1. Go to **Markets** and pick a ticker.
2. Click into a strike to open **Trade**. The header shows the **Price to beat** for that
   contract and that it **Closes 4:00 PM ET**.
3. **Chance** shows the best Yes offer labelled "to buy Yes," or the best Yes bid labelled "last
   bid" when no offer exists. Check the preview for the action you pick for its exact trading
   price.
4. Pick **Buy Yes**, **Buy No**, **Sell Yes**, or **Sell No**, enter a quantity, and choose
   **Market** (trades now against the best available quotes; "You pay" is an estimate) or
   **Limit** (waits at your price until it trades or you cancel it). Review the preview, then
   confirm in your wallet.

## 5. Where to see it settle

Your position shows up right away on **Portfolio**. Each contract trades until its recorded close
time, normally 4:00 PM ET for the daily stock markets. After that it moves toward settlement
using the recorded settlement price, and stays pending until automatic settlement or an operator
override succeeds — Markets and the Trade countdown show **Closed, settling…**, and Portfolio
shows **Closed, settling**, while that's in progress. Once settled, a winning Yes or No token is
worth exactly $1.00, and a losing one is worth $0.00. Head to Portfolio and press **Redeem
winning** to collect it, or check **History** for a record of everything you've done, each entry
linking to the transaction on the block explorer.
