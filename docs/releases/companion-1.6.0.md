# Meterkat companion 1.6.0

**Usage forecast:** every sync keeps the readings of the last 35 days in `usage-history.tsv` in the state directory (private, never uploaded; removed by `meterkat delete`). The desktop app has a new **Forecast** tab and the CLI a `meterkat forecast` command: for every current quota window they show the expected share at the reset or when it runs out, the likely range and what that is based on. The Meterkat Android app uses the same model. Details: [forecast.md](../forecast.md).

**Copy the pairing link:** next to the pairing QR, **Copy link** puts the link on the clipboard so you can paste it in the Meterkat app (**Paste link**) instead of scanning (**Paste link** comes with the next Android update). The clipboard is cleared again when the code expires or a phone connects. The link holds your encryption key: paste it only on your own phone.
